import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { isRootClaimLive, lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import {
  holdsFor,
  haiveDataSaveRequestSchema,
  type HaiveDataFailure,
  type HaiveDataFacts,
  type HaiveDataRefusal,
  type HaiveDataSavePayload,
  type HaiveDataSaveResult,
} from '@haive/shared/haive-data';
import { lockPlanMerge } from '@haive/shared/plan';
import { withoutPlanMirrorErrors } from '../plan/error-scope.js';
import { getDb } from '../db.js';
import { lockPlanMirror, PlanMirrorHeldError } from '../plan/mirror.js';
import { PLAN_MERGE_LIVE_STATUSES } from '../plan/merge.js';
import { checkoutMissing } from '../repo/checkout-head.js';
import { gitOperationInProgress } from '../repo/git-operation.js';
import { detectOrigin, gitRun } from '../repo/git-push.js';
import { requireUsableGit } from '../repo/git-workspace.js';
import {
  flushCurrentPlanMirror,
  PlanMirrorRefusal,
  SavePreconditionError,
  saveCore,
  type SaveScope,
} from '../queues/plan-mirror-queue.js';
import {
  commitHaiveProjections,
  HaiveProjectionRefusal,
  type HaiveProjectionCommit,
} from './commit.js';
import { refreshProjectStateOutcome } from './refresh.js';
import { restoreKeptMetadata, resyncHaiveProjections } from './set-aside.js';
import { lockProjectState } from './write.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Repo = typeof schema.repositories.$inferSelect;
function fail(refusal: HaiveDataRefusal): never {
  throw new PlanMirrorRefusal(refusal.code, refusal);
}

/** The refusal keeps its cause in the log, as commit.ts does for the same read. */
function planFileUnreadable(err: unknown, repositoryId: string): never {
  logger.warn({ err, repositoryId }, 'Haive data plan file read failed');
  return fail({ code: 'record_unreadable' });
}

async function branchAt(repoPath: string): Promise<string | null> {
  const branch = await gitRun(repoPath, ['branch', '--show-current']);
  if (branch.code !== 0) throw new Error('could not read the checkout branch');
  return branch.stdout.trim() || null;
}

/** The caller supplies the repository row it has already read (FOR UPDATE in the final check).
 * Every query inside that final check stays on its transaction's connection. */
async function factsAt(
  conn: Database | Tx,
  repo: Repo,
  payload: HaiveDataSavePayload,
  locked = false,
): Promise<HaiveDataFacts> {
  const repoPath = repo.storagePath ?? repo.localPath;
  const readHolds: NonNullable<HaiveDataFacts['readHolds']>[number][] = [];
  let missing = !repoPath;
  if (repoPath) {
    try {
      missing = await checkoutMissing(repoPath);
    } catch (err) {
      logger.warn({ err, repositoryId: repo.id }, 'Haive data checkout read failed');
      readHolds.push({ code: 'checkout_unreadable' });
    }
  }
  let checkout: HaiveDataFacts['checkout'] = missing ? 'missing' : 'not_git';
  if (!missing && readHolds.length === 0) {
    try {
      checkout = (await requireUsableGit(repoPath!)) ? 'ready' : 'not_git';
    } catch (err) {
      logger.warn({ err, repositoryId: repo.id }, 'Haive data checkout read failed');
      readHolds.push({ code: 'checkout_unreadable' });
    }
  }
  const tasks = await conn
    .select({ id: schema.tasks.id, type: schema.tasks.type })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repo.id),
        inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        isNull(schema.tasks.deadAt),
      ),
    )
    .orderBy(asc(schema.tasks.id));
  const [merge] = await conn
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repo.id),
        eq(schema.tasks.type, 'plan_merge'),
        inArray(schema.tasks.status, [...PLAN_MERGE_LIVE_STATUSES]),
      ),
    )
    .limit(1);
  const questions = await conn
    .select({ unit: schema.projectStateConflicts.unit })
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repo.id),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    );
  const outboxQuery = conn
    .select()
    .from(schema.projectStateOutbox)
    .where(eq(schema.projectStateOutbox.repositoryId, repo.id));
  const [outbox] = await (locked ? outboxQuery.for('update') : outboxQuery);
  const mirrorQuery = conn
    .select({
      revision: schema.planMirrorState.revision,
      writtenRevision: schema.planMirrorState.writtenRevision,
    })
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repo.id));
  const [mirror] = await (locked ? mirrorQuery.for('update') : mirrorQuery);
  let gitOperation = false;
  let branch: string | null = null;
  let origin = true;
  if (checkout === 'ready') {
    try {
      gitOperation = await gitOperationInProgress(repoPath!);
    } catch (err) {
      logger.warn({ err, repositoryId: repo.id }, 'Haive data operation read failed');
      readHolds.push({ code: 'git_operation_unreadable' });
    }
    if (payload.push) {
      try {
        branch = await branchAt(repoPath!);
      } catch (err) {
        logger.warn({ err, repositoryId: repo.id }, 'Haive data branch read failed');
        readHolds.push({ code: 'branch_unreadable' });
      }
      try {
        origin = await detectOrigin(repoPath!);
      } catch (err) {
        logger.warn({ err, repositoryId: repo.id }, 'Haive data origin read failed');
        readHolds.push({ code: 'origin_unreadable' });
      }
    }
  }
  return {
    readHolds,
    checkout,
    rootClaimLive: isRootClaimLive(repo.rootClaimedAt),
    holdingTaskIds: tasks
      .filter((task) => task.type === 'onboarding' || task.type === 'onboarding_upgrade')
      .map((task) => task.id),
    writeIntent: outbox?.writeIntent != null,
    gitOperation,
    planMergeTaskId: merge?.id ?? null,
    pendingUnits: questions.map((question) => question.unit),
    stateDirty: outbox !== undefined && outbox.writtenRevision < outbox.revision,
    mirrorDirty: mirror !== undefined && mirror.writtenRevision < mirror.revision,
    push: payload.push,
    branch,
    origin,
  };
}

export function saveHaiveData(payload: HaiveDataSavePayload): Promise<HaiveDataSaveResult> {
  return withoutPlanMirrorErrors(() => saveHaiveDataInScope(payload));
}

async function saveHaiveDataInScope(payload: HaiveDataSavePayload): Promise<HaiveDataSaveResult> {
  if (!payload.repositoryId || !payload.userId) throw new Error('repositoryId and userId required');
  let result: HaiveDataSaveResult = {
    indexSynced: true,
    outcome: 'unchanged',
    committed: false,
    commitSha: null,
    files: [],
    skipped: [],
    pushed: false,
    branch: null,
    refusal: null,
  };
  const request = haiveDataSaveRequestSchema.safeParse(payload);
  if (!request.success)
    return { ...result, outcome: 'refused', refusal: { code: 'invalid_request' } };
  payload = { ...payload, ...request.data };
  const db = getDb();
  const [repo] = await db
    .select()
    .from(schema.repositories)
    .where(
      and(
        eq(schema.repositories.id, payload.repositoryId),
        eq(schema.repositories.userId, payload.userId),
      ),
    );
  if (!repo) throw new Error('repository not found');
  let expectedBranch: string | null = null;
  let failureCode: HaiveDataFailure['code'] = 'save_failed';
  const note = (commit: HaiveProjectionCommit) => {
    result = {
      ...result,
      indexSynced: commit.indexSynced ?? true,
      committed: result.committed || commit.committed,
      commitSha: commit.commitSha ?? result.commitSha,
      files: [...new Set([...result.files, ...commit.files])].sort(),
      skipped: [...new Set([...result.skipped, ...commit.skipped])].sort(),
    };
  };
  const flush = async () => {
    // The mirror writer must never be asked to replace a linked/non-file plan path.
    // Inspect before either flush so this is a structured refusal with no new commit.
    for (const rel of ['.haive-data/plan.json', '.haive-data/plan.md']) {
      let entry;
      try {
        entry = await lstatNoFollow((repo.storagePath ?? repo.localPath)!, rel, { strict: true });
      } catch (err) {
        planFileUnreadable(err, repo.id);
      }
      if (entry && entry.kind !== 'file')
        planFileUnreadable(new Error(`${rel} is not a regular file`), repo.id);
    }
    try {
      await flushCurrentPlanMirror(repo.id);
    } catch (err) {
      if (err instanceof PlanMirrorHeldError) {
        const holds = holdsFor(await factsAt(db, repo, payload));
        if (holds[0]) fail(holds[0]);
        if (err.code === 'git_operation') fail({ code: 'git_operation' });
        fail({ code: err.code });
      }
      throw err;
    }
    const refreshed = await refreshProjectStateOutcome(db, repo.id);
    switch (refreshed.outcome) {
      case 'written':
        return;
      case 'blocked':
        fail({ code: refreshed.code, file: refreshed.file });
      case 'missing':
        fail({ code: 'checkout_missing' });
      case 'absent':
        fail({ code: 'record_absent' });
      case 'superseded':
        fail({ code: 'checkout_changed' });
      case 'refused':
        fail({
          code: refreshed.reason === 'context' ? 'render_context_refused' : 'record_refused',
        });
      case 'held': {
        const holds = holdsFor(await factsAt(db, repo, payload));
        const hold = holds[0];
        if (hold) fail(hold);
        if (refreshed.reason === 'checkout') fail({ code: 'checkout_changed' });
        fail({
          code:
            refreshed.code ??
            (refreshed.reason === 'git_operation' ? 'git_operation' : 'write_pending'),
        });
      }
      default: {
        // An outcome added to ProjectStateRefreshOutcome must be mapped above (this stops compiling
        // until it is); a value that gets past it anyway refuses rather than read as a flush that wrote.
        const unhandled: never = refreshed;
        logger.error(
          { repositoryId: repo.id, flush: unhandled },
          'Haive data record flush returned an outcome the Save does not handle',
        );
        fail({ code: 'projections_changing' });
      }
    }
  };
  const commit = async ({ repoPath, identity, message }: SaveScope) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await flush();
      const saved = await db.transaction(async (tx) => {
        await lockPlanMerge(tx, repo.id);
        await lockRepositoryTasksKey(tx, repo.id);
        await lockProjectState(tx, repo.id);
        await lockPlanMirror(tx, repo.id);
        const [locked] = await tx
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repo.id))
          .for('update');
        if (
          !locked ||
          locked.userId !== payload.userId ||
          (locked.storagePath ?? locked.localPath) !== repoPath ||
          locked.onboardingResetAt?.getTime() !== repo.onboardingResetAt?.getTime()
        )
          fail({ code: 'checkout_changed' });
        const facts = await factsAt(tx, locked, payload, true);
        const holds = holdsFor(facts);
        const refusal = holds[0];
        if (refusal) fail(refusal);
        if (payload.push && facts.branch !== expectedBranch) fail({ code: 'checkout_changed' });
        if (facts.stateDirty || facts.mirrorDirty) return null;
        try {
          const committed = await commitHaiveProjections({
            repositoryId: repo.id,
            repoPath,
            identity,
            message,
          });
          note(committed); // The Git commit survives even if the transaction commit fails.
          return committed;
        } catch (err) {
          if (err instanceof HaiveProjectionRefusal) fail(err.refusal);
          throw err;
        }
      });
      if (saved) {
        return saved;
      }
    }
    return fail({ code: 'projections_changing' });
  };
  try {
    const saved = await saveCore(payload, {
      onFailure(_err, code) {
        failureCode = code;
      },
      onLanded(sha) {
        result = { ...result, committed: true, commitSha: sha };
      },
      onPushed(sha) {
        result = { ...result, pushed: true, commitSha: sha };
      },
      async prepare() {
        const facts = await factsAt(db, repo, payload);
        const refusal = holdsFor(facts)[0];
        if (refusal) fail(refusal);
        expectedBranch = facts.branch;
        await flush();
        return {
          files: [],
          repoPath: (repo.storagePath ?? repo.localPath)!,
          message: 'chore(haive): save Haive data',
          ...(payload.push && expectedBranch ? { expectedBranch } : {}),
        };
      },
      commit,
      async afterLanding(scope) {
        try {
          if (!(await resyncHaiveProjections(db, repo.id, scope.repoPath)))
            fail({ code: 'resync_failed' });
          // Re-check questions under all four locks before any new record is committed.
          await commit(scope);
        } finally {
          await restoreKeptMetadata(scope.repoPath, scope.kept);
        }
      },
    });
    return {
      ...result,
      outcome: saved.conflict
        ? 'conflict'
        : result.committed || saved.pushed
          ? 'saved'
          : 'unchanged',
      pushed: saved.pushed,
      branch: saved.branch,
      ...(saved.conflict ? { conflict: saved.conflict } : {}),
    };
  } catch (err) {
    if (!(err instanceof PlanMirrorRefusal) && !(err instanceof SavePreconditionError)) {
      logger.error({ err, repositoryId: repo.id, code: failureCode }, 'Haive data Save failed');
      return {
        ...result,
        outcome: 'failed',
        branch: expectedBranch,
        failure: { code: failureCode },
      };
    }
    return {
      ...result,
      outcome: 'refused',
      branch: expectedBranch,
      refusal: err.refusal ?? { code: 'integration_refused' },
    };
  }
}
