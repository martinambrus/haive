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
import { loadProvenanceSteps } from '../src/routes/repos.js';

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
    }): Promise<void> => {
      const taskId = randomUUID();
      await db.insert(schema.tasks).values({
        id: taskId,
        userId,
        repositoryId: opts.repositoryId,
        type: 'onboarding',
        title: `smoke ${opts.marker}`,
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
        output:
          opts.shape === 'skill-repair'
            ? { repaired: [opts.marker], stillFailing: [], attempted: 1 }
            : { wroteFiles: [opts.marker] },
        createdAt: opts.startedAt,
        updatedAt: opts.startedAt,
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
    // 11d writes in a task WORKTREE, so its record never describes the repository root and the
    // query must not return it however complete the run was.
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
      'a worktree-scoped skill sync is never read as repository provenance',
      !unscoped.includes('post-reset-worktree-skill-sync'),
      unscoped,
    );
    check(
      'a null epoch reads every run of this repo',
      unscoped.join(',') ===
        ['post-reset-done', 'post-reset-skill-repair', 'pre-reset-done'].join(','),
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
      scoped.join(',') === ['post-reset-done', 'post-reset-skill-repair'].join(','),
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
