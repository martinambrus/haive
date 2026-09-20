/**
 * The two predicates the onboarding-artifact reset trusts, exercised against a real database.
 *
 * `loadProvenanceSteps` decides which runs' records may be read as evidence of what Haive wrote,
 * and everything downstream — what is removed, what is quarantined, what is left — rests on its
 * answer. Both predicates are SQL, so the unit suite (which runs against no database) cannot
 * reach either:
 *
 *   - `status = 'done'`, because 07 persists its detect payload BEFORE the form is shown, so a
 *     run cancelled or failed while parked there names directories nothing was written to;
 *   - `tasks.created_at > onboarding_reset_at`, because a reset supersedes artifact rows but
 *     CANNOT touch `task_steps`, so a pre-reset run's record still names paths the reset deleted.
 *
 * Safe against a populated install: it creates ONE throwaway user with its own repository and
 * asserts only about that repository, then deletes the user in a `finally` — the cascade takes
 * its repository, tasks and steps with it. Nothing else in the database is read or written.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { loadOnboardingTaskFacts } from '../src/lib/onboarding-state.js';
import { loadLiveRootWriters, loadProvenanceSteps } from '../src/routes/repos.js';

const log = logger.child({ module: 'onboarding-reset-provenance-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

const RESET_AT = new Date('2026-01-10T00:00:00Z');
const BEFORE_RESET = new Date('2026-01-01T00:00:00Z');
const AFTER_RESET = new Date('2026-01-20T00:00:00Z');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();

  const userId = randomUUID();
  const repoId = randomUUID();
  const otherRepoId = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'reset-provenance-smoke',
      emailBlindIndex: `reset-provenance-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const id of [repoId, otherRepoId]) {
      await db.insert(schema.repositories).values({
        id,
        userId,
        name: `reset-provenance-smoke-${id.slice(0, 8)}`,
        source: 'blank',
        createdAt: now,
        updatedAt: now,
      });
    }

    /** One task with one step, at a chosen start time. Returns nothing — the step id and status
     *  are what the assertions key on. */
    const seed = async (opts: {
      repositoryId: string;
      startedAt: Date;
      stepId: string;
      status: 'done' | 'waiting_form' | 'failed';
      marker: string;
      /** 09_5b emits `{ repaired, ... }` rather than `wroteFiles`; the marker rides whichever
       *  field that step really uses, so no row here teaches a shape the code never sees. */
      shape?: 'wrote' | 'skill-repair';
      /** The merge phase's durable record, for a `12-worktree-cleanup` row. */
      mergeResolveState?: unknown;
      /** When the step finished, if later than the task's start — a retry. */
      endedAt?: Date;
    }): Promise<void> => {
      const taskId = randomUUID();
      await db.insert(schema.tasks).values({
        id: taskId,
        userId,
        repositoryId: opts.repositoryId,
        type: 'onboarding',
        title: `smoke ${opts.marker}`,
        // Terminal, so these runs do not themselves count as LIVE — the live-task check below
        // must see only the task it plants.
        status: 'completed',
        createdAt: opts.startedAt,
        updatedAt: opts.startedAt,
      });
      await db.insert(schema.taskSteps).values({
        id: randomUUID(),
        taskId,
        stepId: opts.stepId,
        stepIndex: 7,
        title: opts.marker,
        status: opts.status,
        ...(opts.mergeResolveState === undefined
          ? {}
          : { mergeResolveState: opts.mergeResolveState as never }),
        output:
          opts.shape === 'skill-repair'
            ? { repaired: [opts.marker], stillFailing: [], attempted: 1 }
            : { wroteFiles: [opts.marker] },
        createdAt: opts.startedAt,
        updatedAt: opts.startedAt,
        // When the step actually WROTE — the clock the epoch filters on. Defaults to the task's
        // own start, so a RETRY is modelled by handing a later one.
        endedAt: opts.endedAt ?? opts.startedAt,
      });
    };

    await seed({
      repositoryId: repoId,
      startedAt: BEFORE_RESET,
      stepId: '07-generate-files',
      status: 'done',
      marker: 'pre-reset-done',
    });
    await seed({
      repositoryId: repoId,
      startedAt: AFTER_RESET,
      stepId: '07-generate-files',
      status: 'done',
      marker: 'post-reset-done',
    });
    await seed({
      repositoryId: repoId,
      startedAt: AFTER_RESET,
      stepId: '07-generate-files',
      status: 'waiting_form',
      marker: 'post-reset-parked',
    });
    await seed({
      repositoryId: repoId,
      startedAt: AFTER_RESET,
      stepId: '09_5b-skill-repair',
      status: 'done',
      marker: 'post-reset-skill-repair',
      shape: 'skill-repair',
    });
    // 11d writes in a task WORKTREE. Its row IS loaded — the merge verdict decides whether it
    // counts — so the query returns it and `collectWrittenCliContent` gates on `12`.
    await seed({
      repositoryId: repoId,
      startedAt: AFTER_RESET,
      stepId: '11d-skill-sync',
      status: 'done',
      marker: 'post-reset-worktree-skill-sync',
    });
    await seed({
      repositoryId: repoId,
      startedAt: AFTER_RESET,
      stepId: '08-knowledge-acquisition',
      status: 'done',
      marker: 'post-reset-other-step',
    });
    await seed({
      repositoryId: otherRepoId,
      startedAt: AFTER_RESET,
      stepId: '07-generate-files',
      status: 'done',
      marker: 'other-repo-done',
    });

    const markersOf = (rows: Array<{ output: unknown }>): string[] =>
      rows
        .flatMap((row) => {
          const out = row.output as { wroteFiles?: string[]; repaired?: string[] } | null;
          return [...(out?.wroteFiles ?? []), ...(out?.repaired ?? [])];
        })
        .sort();

    // NULL epoch: every repo that has never been reset, which must read exactly as it did before
    // the column existed.
    const unscoped = markersOf(await loadProvenanceSteps(db, repoId, null));
    check(
      'a parked run is never read — its detect payload predates the form',
      !unscoped.includes('post-reset-parked'),
      unscoped,
    );
    check(
      'a step outside the provenance set is never read',
      !unscoped.includes('post-reset-other-step'),
      unscoped,
    );
    check('another repository never leaks in', !unscoped.includes('other-repo-done'), unscoped);
    check(
      'a worktree-scoped skill sync is loaded, for the merge verdict to rule on',
      unscoped.includes('post-reset-worktree-skill-sync'),
      unscoped,
    );
    check(
      'a null epoch reads every run of this repo',
      unscoped.join(',') ===
        [
          'post-reset-done',
          'post-reset-skill-repair',
          'post-reset-worktree-skill-sync',
          'pre-reset-done',
        ].join(','),
      unscoped,
    );

    // With the stamp set, the pre-reset run is the one whose record names paths the reset already
    // deleted — reading it is what would claim a file the user recreated by hand.
    const scoped = markersOf(await loadProvenanceSteps(db, repoId, RESET_AT));
    check(
      'a run that started before the reset is dropped',
      !scoped.includes('pre-reset-done'),
      scoped,
    );
    check(
      'runs after the reset are kept, skill repair included',
      scoped.join(',') ===
        ['post-reset-done', 'post-reset-skill-repair', 'post-reset-worktree-skill-sync'].join(','),
      scoped,
    );

    // The stamp the route actually writes must be readable back as a Date, or the scoping above
    // never engages in production however well it behaves here.
    await db
      .update(schema.repositories)
      .set({ onboardedAt: null, onboardingResetAt: RESET_AT, updatedAt: new Date() })
      .where(eq(schema.repositories.id, repoId));
    const row = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repoId),
      columns: { onboardingResetAt: true, onboardedAt: true },
    });
    // A step RETRIED after the reset wrote after it, however old its task is. Keying on
    // `tasks.created_at` excluded this for good while the files sat on disk.
    await seed({
      repositoryId: repoId,
      startedAt: BEFORE_RESET,
      endedAt: AFTER_RESET,
      stepId: '07-generate-files',
      status: 'done',
      marker: 'pre-reset-task-retried-after',
    });
    const retried = markersOf(await loadProvenanceSteps(db, repoId, RESET_AT));
    check(
      'a step retried after the reset is read, however old its task is',
      retried.includes('pre-reset-task-retried-after'),
      retried,
    );

    // `12-worktree-cleanup` throws when `removeWorktreeDir` fails AFTER the merge is committed,
    // so the step is FAILED while the merge is real. The row must still be loaded, or the merge
    // verdict is lost and the sync's changes are never credited. This predicate is SQL, so the
    // unit suite cannot reach it — a mutation that drops `'failed'` fails nothing there.
    await seed({
      repositoryId: repoId,
      startedAt: AFTER_RESET,
      stepId: '12-worktree-cleanup',
      status: 'failed',
      marker: 'post-reset-failed-cleanup',
      mergeResolveState: { merged: true },
    });
    const withCleanup = await loadProvenanceSteps(db, repoId, RESET_AT);
    check(
      'a cleanup step that failed after a durable merge is still loaded',
      withCleanup.some(
        (r) =>
          r.stepId === '12-worktree-cleanup' &&
          (r.mergeResolveState as { merged?: unknown } | null)?.merged === true,
      ),
      withCleanup.map((r) => r.stepId),
    );

    // A live WORKFLOW merges its worktree at `12-worktree-cleanup`, landing 11d's skills in the
    // root — so a reset must refuse while one is running, or a merge completing mid-sweep leaves
    // that workflow without the artifacts it just merged. Another query the unit suite cannot
    // reach: dropping `workflow` from the type list fails nothing there.
    const workflowId = randomUUID();
    await db.insert(schema.tasks).values({
      id: workflowId,
      userId,
      repositoryId: repoId,
      type: 'workflow',
      title: 'smoke live workflow',
      status: 'running',
      createdAt: AFTER_RESET,
      updatedAt: AFTER_RESET,
    });
    check(
      'a live workflow blocks the reset, because it can merge into the root',
      (await loadLiveRootWriters(db, userId, repoId)).length === 1,
      null,
    );
    await db.delete(schema.tasks).where(eq(schema.tasks.id, workflowId));
    check(
      'with no root writer live, the reset may proceed',
      (await loadLiveRootWriters(db, userId, repoId)).length === 0,
      null,
    );

    // A reset must be REFUSED while an onboarding run is live: it writes into the tree the
    // reset deletes, and its later steps would carry a `created_at` older than the epoch.
    const liveTaskId = randomUUID();
    await db.insert(schema.tasks).values({
      id: liveTaskId,
      userId,
      repositoryId: repoId,
      type: 'onboarding',
      title: 'smoke live onboarding',
      status: 'waiting_user',
      createdAt: AFTER_RESET,
      updatedAt: AFTER_RESET,
    });
    const live = (await loadOnboardingTaskFacts(db, userId, [repoId])).get(repoId);
    check(
      'a parked onboarding run counts as live, so the reset is refused',
      live?.liveTaskId === liveTaskId,
      live,
    );
    await db.delete(schema.tasks).where(eq(schema.tasks.id, liveTaskId));
    const afterLive = (await loadOnboardingTaskFacts(db, userId, [repoId])).get(repoId);
    check(
      'completed runs alone leave nothing live, so the reset may proceed',
      afterLive?.liveTaskId === null && afterLive?.hasCompleted === true,
      afterLive,
    );

    check(
      'the reset stamp round-trips and clears the onboarded stamp',
      row?.onboardingResetAt?.getTime() === RESET_AT.getTime() && row?.onboardedAt === null,
      row,
    );
  } finally {
    // Cascade takes the repositories, tasks and steps with it.
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }

  if (failures > 0) {
    log.error({ failures }, 'smoke FAILED');
    process.exit(1);
  }
  log.info('smoke passed');
}

main().then(
  () => process.exit(0),
  (err) => {
    log.error({ err }, 'smoke crashed');
    process.exit(1);
  },
);
