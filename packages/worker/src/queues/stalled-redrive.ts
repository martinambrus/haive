import {
  and,
  asc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  logger,
  TASK_JOB_NAMES,
  type RepoRagCleanupPayload,
  type RepoResourceCleanupPayload,
} from '@haive/shared';
import { reconcileStrandedSyncingBundles } from '../data-migrations.js';
import { resyncAfterTaskEnd } from '../project-state/set-aside.js';
import { recordLeftOpenMerges } from '../step-engine/left-open-merge.js';
import { releaseTaskMergeClaims } from '../step-engine/merge-dir-claim.js';
import { discardPlanMerge } from '../step-engine/steps/plan/01-plan-merge.js';
import {
  enqueueAdvance,
  enqueueCancel,
  enqueueRepoCleanup,
  enqueueStart,
  finishFailedStep,
  getTaskQueue,
  readQueuedInvocationIds,
  recoverParkedStep,
  retrying,
  REDRIVE_RETRY_DELAYS_MS,
} from './task-queue.js';

/**
 * Catches what reconcileOrphanedSteps cannot: a step its own re-drive enqueue failed to queue,
 * or any hand-off lost between boots, left `pending`/missing, finished with nothing after it, or
 * failed with the task still running; a task queued to start whose START was lost; and a step
 * parked on a run whose cli-exec job was; and a cancelled task whose teardown never finished.
 */

const log = logger.child({ module: 'stalled-redrive' });

export interface FailedStep {
  taskId: string;
  epoch: number;
  stepId: string;
  rowId: string;
  message: string;
}

export interface StalledRedriveDeps {
  enqueueAdvance: (
    taskId: string,
    userId: string,
    stepId: string,
    round: number,
    epoch: number,
  ) => Promise<void>;
  /** Fail a running task at `epoch`, as the lost hand-off of its failed step would have. */
  failTask: (db: Database, failed: FailedStep) => Promise<boolean>;
  enqueueStart: (taskId: string, userId: string) => Promise<void>;
  /** What the task queue still owes each task, or null when the queue could not be read. */
  queuedTaskJobs: () => Promise<TaskQueueOwed | null>;
  /** Every invocation a cli-exec job still owes a run, or null when the queue could not be read. */
  queuedInvocationIds: () => Promise<Set<string> | null>;
  redriveRetryDelaysMs?: number[];
}

export interface TaskQueueOwed {
  /** Tasks a job still owes a step. A START owes none: it only claims a task still waiting to
   *  start, so one a dead worker left `active` under its lock must not hold a running task. */
  steps: Set<string>;
  /** Tasks a START is still queued for. */
  starts: Set<string>;
}

export function taskQueueOwed(
  jobs: readonly ({ name?: string; data?: unknown } | undefined)[],
): TaskQueueOwed {
  const owed: TaskQueueOwed = { steps: new Set(), starts: new Set() };
  for (const job of jobs) {
    const id = (job?.data as { taskId?: unknown } | undefined)?.taskId;
    if (typeof id !== 'string') continue;
    (job?.name === TASK_JOB_NAMES.START ? owed.starts : owed.steps).add(id);
  }
  return owed;
}

/** 'active' is redelivered; 'delayed' covers a holdStepAdvance, admission, or PAUSE park. */
async function readTaskQueueJobs(): Promise<TaskQueueOwed | null> {
  try {
    const jobs = await getTaskQueue().getJobs([
      'active',
      'waiting',
      'waiting-children',
      'delayed',
      'prioritized',
    ]);
    return taskQueueOwed(jobs);
  } catch (err) {
    log.warn({ err }, 'task queue unreadable; leaving stalled tasks alone this pass');
    return null;
  }
}

export const defaultDeps: StalledRedriveDeps = {
  enqueueAdvance,
  failTask: (db, f) =>
    finishFailedStep(
      db,
      { taskId: f.taskId, orchestrationEpoch: f.epoch },
      f.stepId,
      { id: f.rowId },
      f.message,
      ['running'],
    ),
  enqueueStart,
  queuedTaskJobs: readTaskQueueJobs,
  queuedInvocationIds: readQueuedInvocationIds,
};

/** A current row that shows the task's hand-off was lost: pending and not parked, or finished
 *  (a job that died between the row's end and pointing the task on), and idle since `cutoff`. */
function redrivableRow(cutoff: Date) {
  return and(
    lt(schema.taskSteps.updatedAt, cutoff),
    or(
      and(eq(schema.taskSteps.status, 'pending'), isNull(schema.taskSteps.waitingStartedAt)),
      inArray(schema.taskSteps.status, ['done', 'skipped']),
    ),
  )!;
}

interface StalledCandidate {
  taskId: string;
  userId: string;
  stepId: string;
  round: number;
  epoch: number;
}

/** Locks the task row, then re-checks the whole candidate predicate before bumping the epoch:
 *  a step a pass claimed since the candidate read is left to that pass. */
async function redriveTask(
  db: Database,
  c: StalledCandidate,
  deps: StalledRedriveDeps,
  cutoff: Date,
): Promise<boolean> {
  const fenced = await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, c.taskId))
      .for('update');
    if (locked.length === 0) return null;
    const [row] = await tx
      .update(schema.tasks)
      .set({
        orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.id, c.taskId),
          eq(schema.tasks.status, 'running'),
          isNull(schema.tasks.deadAt),
          eq(schema.tasks.orchestrationEpoch, c.epoch),
          sql`${schema.tasks.currentStepId} IS NOT DISTINCT FROM ${c.stepId}`,
          eq(schema.tasks.currentRound, c.round),
          lt(schema.tasks.updatedAt, cutoff),
          not(
            exists(
              tx
                .select({ one: sql`1` })
                .from(schema.taskSteps)
                .where(
                  and(
                    eq(schema.taskSteps.taskId, c.taskId),
                    eq(schema.taskSteps.stepId, c.stepId),
                    eq(schema.taskSteps.round, c.round),
                    not(redrivableRow(cutoff)),
                  ),
                ),
            ),
          ),
        ),
      )
      .returning({ epoch: schema.tasks.orchestrationEpoch });
    return row ?? null;
  });
  if (!fenced) return false;

  try {
    await retrying(
      () => deps.enqueueAdvance(c.taskId, c.userId, c.stepId, c.round, fenced.epoch),
      deps.redriveRetryDelaysMs ?? REDRIVE_RETRY_DELAYS_MS,
    );
  } catch (err) {
    await db
      .update(schema.tasks)
      .set({ orchestrationEpoch: c.epoch, updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, c.taskId), eq(schema.tasks.orchestrationEpoch, fenced.epoch)));
    throw err;
  }
  log.info(
    { taskId: c.taskId, stepId: c.stepId, round: c.round, epoch: fenced.epoch },
    'redrove a stalled task',
  );
  return true;
}

/** A step's runs a live worker may still start: recorded, never started, still standing. */
function unstartedRun(taskStepId: SQLWrapper | string) {
  return and(
    eq(schema.cliInvocations.taskStepId, taskStepId),
    isNull(schema.cliInvocations.startedAt),
    isNull(schema.cliInvocations.endedAt),
    isNull(schema.cliInvocations.supersededAt),
  );
}

/** One pass: re-drives each running task whose current step row is missing, pending and not
 *  parked, or finished, and fails one whose current row failed; queues a START for a task still
 *  queued to start; and recovers a parked
 *  step whose recorded run no cli-exec job owes any more, as boot does. Each only while the task
 *  queue holds no job for the task. */
export async function redriveStalledTasks(
  db: Database,
  deps: StalledRedriveDeps = defaultDeps,
  opts: { staleMs: number },
): Promise<number> {
  const cutoff = new Date(Date.now() - opts.staleMs);
  const candidates = await db
    .select({
      taskId: schema.tasks.id,
      userId: schema.tasks.userId,
      stepId: schema.tasks.currentStepId,
      round: schema.tasks.currentRound,
      epoch: schema.tasks.orchestrationEpoch,
      rowId: schema.taskSteps.id,
      rowStatus: schema.taskSteps.status,
      rowError: schema.taskSteps.errorMessage,
    })
    .from(schema.tasks)
    .leftJoin(
      schema.taskSteps,
      and(
        eq(schema.taskSteps.taskId, schema.tasks.id),
        eq(schema.taskSteps.stepId, schema.tasks.currentStepId),
        eq(schema.taskSteps.round, schema.tasks.currentRound),
      ),
    )
    .where(
      and(
        eq(schema.tasks.status, 'running'),
        isNull(schema.tasks.deadAt),
        isNotNull(schema.tasks.currentStepId),
        lt(schema.tasks.updatedAt, cutoff),
        or(
          isNull(schema.taskSteps.id),
          redrivableRow(cutoff),
          and(eq(schema.taskSteps.status, 'failed'), lt(schema.taskSteps.updatedAt, cutoff)),
        ),
      ),
    );
  // `created` is left alone: a deferred-start draft waits there on purpose.
  const unstartedTasks = await db
    .select({ taskId: schema.tasks.id, userId: schema.tasks.userId })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'queued'),
        isNull(schema.tasks.deadAt),
        lt(schema.tasks.updatedAt, cutoff),
      ),
    );
  const parkedSteps = await db
    .select({
      taskStepId: schema.taskSteps.id,
      taskId: schema.tasks.id,
      stepId: schema.taskSteps.stepId,
      round: schema.taskSteps.round,
      userId: schema.tasks.userId,
      epoch: schema.tasks.orchestrationEpoch,
      currentStepId: schema.tasks.currentStepId,
      currentRound: schema.tasks.currentRound,
    })
    .from(schema.tasks)
    .innerJoin(
      schema.taskSteps,
      and(
        eq(schema.taskSteps.taskId, schema.tasks.id),
        eq(schema.taskSteps.stepId, schema.tasks.currentStepId),
        eq(schema.taskSteps.round, schema.tasks.currentRound),
      ),
    )
    .where(
      and(
        eq(schema.tasks.status, 'running'),
        isNull(schema.tasks.deadAt),
        lt(schema.tasks.updatedAt, cutoff),
        eq(schema.taskSteps.status, 'waiting_cli'),
        lt(schema.taskSteps.updatedAt, cutoff),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.cliInvocations)
            .where(
              and(unstartedRun(schema.taskSteps.id), lt(schema.cliInvocations.createdAt, cutoff)),
            ),
        ),
        // A run that is running says the worker behind the step is alive.
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(schema.cliInvocations)
              .where(
                and(
                  eq(schema.cliInvocations.taskStepId, schema.taskSteps.id),
                  isNotNull(schema.cliInvocations.startedAt),
                  isNull(schema.cliInvocations.endedAt),
                  isNull(schema.cliInvocations.supersededAt),
                ),
              ),
          ),
        ),
      ),
    );
  if (candidates.length === 0 && unstartedTasks.length === 0 && parkedSteps.length === 0) {
    return 0;
  }

  const queued = await deps.queuedTaskJobs();
  if (queued === null) return 0;

  let redriven = 0;
  for (const c of candidates) {
    if (c.stepId === null) continue; // excluded by isNotNull above; narrows the type
    if (queued.steps.has(c.taskId)) continue;
    try {
      if (c.rowStatus === 'failed' && c.rowId !== null) {
        // Its job died between failing the step and failing the task, and every write refuses a
        // failed row, so no advance could run it again.
        const failed: FailedStep = {
          taskId: c.taskId,
          epoch: c.epoch,
          stepId: c.stepId,
          rowId: c.rowId,
          message: c.rowError ?? 'the step failed',
        };
        if (await deps.failTask(db, failed)) redriven++;
      } else if (await redriveTask(db, { ...c, stepId: c.stepId }, deps, cutoff)) redriven++;
    } catch (err) {
      log.error({ err, taskId: c.taskId }, 'stalled task redrive failed');
    }
  }

  for (const t of unstartedTasks) {
    if (queued.starts.has(t.taskId)) continue;
    try {
      await retrying(
        () => deps.enqueueStart(t.taskId, t.userId),
        deps.redriveRetryDelaysMs ?? REDRIVE_RETRY_DELAYS_MS,
      );
      redriven++;
      log.info({ taskId: t.taskId }, 'queued a START for a task whose own was lost');
    } catch (err) {
      log.error({ err, taskId: t.taskId }, 'stalled task START could not be queued');
    }
  }

  const lostRuns = parkedSteps.filter((p) => !queued.steps.has(p.taskId));
  if (lostRuns.length === 0) return redriven;
  const owed = await deps.queuedInvocationIds();
  if (owed === null) return redriven;
  for (const p of lostRuns) {
    try {
      const recorded = await db
        .select({ id: schema.cliInvocations.id })
        .from(schema.cliInvocations)
        .where(and(unstartedRun(p.taskStepId), lt(schema.cliInvocations.createdAt, cutoff)));
      if (recorded.every((r) => owed.has(r.id))) continue;
      if (await recoverParkedStep(db, p, owed, deps, cutoff)) redriven++;
    } catch (err) {
      log.error({ err, taskId: p.taskId, stepId: p.stepId }, 'parked step recovery failed');
    }
  }
  return redriven;
}

export interface CancelRedriveDeps {
  enqueueCancel: (taskId: string, userId: string) => Promise<void>;
  /** Tasks a CANCEL is still queued for, or null when the queue could not be read. */
  queuedCancelTaskIds: () => Promise<Set<string> | null>;
}

/** Not completed or failed jobs: a CANCEL that died before `task.cancel_finished` must be re-driven. */
export async function readQueuedCancelTaskIds(): Promise<Set<string> | null> {
  try {
    const jobs = await getTaskQueue().getJobs([
      'active',
      'waiting',
      'waiting-children',
      'delayed',
      'prioritized',
    ]);
    const ids = new Set<string>();
    for (const job of jobs) {
      const id = (job?.data as { taskId?: unknown } | undefined)?.taskId;
      if (job?.name === TASK_JOB_NAMES.CANCEL && typeof id === 'string') ids.add(id);
    }
    return ids;
  } catch (err) {
    log.warn({ err }, 'task queue unreadable; leaving cancelled tasks alone this pass');
    return null;
  }
}

export const defaultCancelDeps: CancelRedriveDeps = {
  enqueueCancel,
  queuedCancelTaskIds: readQueuedCancelTaskIds,
};

export const CANCEL_REDRIVE_BATCH = 20;
/** A teardown that fails every time is re-driven this often, then abandoned. */
export const CANCEL_REDRIVE_MAX = 3;
const CANCEL_REDRIVEN_EVENT = 'task.cancel_redriven';
/** The re-drive leaves older cancellations alone: many predate the finish record. */
export const CANCEL_REDRIVE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** For `exists`: the events of one type on the task of the outer query. */
function taskEventsOf(db: Database) {
  return (type: string, ...more: ReturnType<typeof eq>[]) =>
    db
      .select({ one: sql`1` })
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, schema.tasks.id),
          eq(schema.taskEvents.eventType, type),
          ...more,
        ),
      );
}

/** Queues a CANCEL for a task cancelled before the cutoff with no `task.cancel_finished`: the api commits the cancel before queueing. */
export async function redriveCancelledTasks(
  db: Database,
  deps: CancelRedriveDeps = defaultCancelDeps,
  opts: { staleMs: number },
): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - opts.staleMs);
  const since = new Date(now - CANCEL_REDRIVE_LOOKBACK_MS);
  const event = taskEventsOf(db);
  const candidates = await db
    .select({
      taskId: schema.tasks.id,
      userId: schema.tasks.userId,
      attempts: sql<number>`(select count(*)::int from ${schema.taskEvents} where ${schema.taskEvents.taskId} = ${schema.tasks.id} and ${schema.taskEvents.eventType} = ${CANCEL_REDRIVEN_EVENT})`,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'cancelled'),
        exists(event('task.cancelled', gt(schema.taskEvents.createdAt, since))),
        not(exists(event('task.cancelled', gte(schema.taskEvents.createdAt, cutoff)))),
        not(exists(event('task.cancel_finished'))),
        sql`(select count(*) from ${schema.taskEvents} where ${schema.taskEvents.taskId} = ${schema.tasks.id} and ${schema.taskEvents.eventType} = ${CANCEL_REDRIVEN_EVENT}) < ${CANCEL_REDRIVE_MAX}`,
      ),
    )
    .orderBy(asc(schema.tasks.updatedAt))
    .limit(CANCEL_REDRIVE_BATCH);
  if (candidates.length === 0) return 0;

  const queued = await deps.queuedCancelTaskIds();
  if (queued === null) return 0;

  let redriven = 0;
  for (const t of candidates) {
    if (queued.has(t.taskId)) continue;
    try {
      // Counted before the job exists: a lost count would let a failing teardown escape the cap.
      const attempt = Number(t.attempts ?? 0) + 1;
      await db
        .insert(schema.taskEvents)
        .values({ taskId: t.taskId, eventType: CANCEL_REDRIVEN_EVENT, payload: { attempt } });
      await deps.enqueueCancel(t.taskId, t.userId);
      redriven++;
      if (attempt >= CANCEL_REDRIVE_MAX) {
        log.warn(
          { taskId: t.taskId, attempt },
          'last re-drive of a cancelled task whose teardown keeps failing; if it fails too, the teardown is abandoned',
        );
      } else {
        log.info(
          { taskId: t.taskId, attempt },
          'queued a CANCEL for a cancelled task whose teardown never ran',
        );
      }
    } catch (err) {
      log.error({ err, taskId: t.taskId }, 'cancelled task teardown could not be queued');
    }
  }
  return redriven;
}

async function abandonTeardown(db: Database, taskId: string, reason: string): Promise<void> {
  // A throw stops here, before any release: the merge is unreported and the next pass retries.
  await recordLeftOpenMerges(db, taskId);
  const steps = [
    ['releaseTaskMergeClaims', releaseTaskMergeClaims],
    ['discardPlanMerge', discardPlanMerge],
    ['resyncAfterTaskEnd', resyncAfterTaskEnd],
  ] as const;
  // A failed step is logged, not retried: the record below is what frees the dir (`liveClaimHolder`).
  for (const [step, run] of steps) {
    try {
      await run(db, taskId);
    } catch (err) {
      log.warn(
        { err, taskId, step },
        'a teardown step failed for a cancelled task being abandoned',
      );
    }
  }
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId: null,
    eventType: 'task.cancel_finished',
    payload: { source: 'worker', abandoned: true, reason },
  });
  log.warn(
    { taskId, reason },
    'abandoned the teardown of a cancelled task; its merge dir claims are released',
  );
}

/** Finishes as abandoned the cancel of a task still holding a merge dir claim that the re-drive no
 *  longer retries: capped with its last attempt past the cutoff, or cancelled before the window. */
export async function abandonCancelledTeardowns(
  db: Database,
  deps: Pick<CancelRedriveDeps, 'queuedCancelTaskIds'> = defaultCancelDeps,
  opts: { staleMs: number },
): Promise<number> {
  const now = Date.now();
  const cutoff = new Date(now - opts.staleMs);
  const since = new Date(now - CANCEL_REDRIVE_LOOKBACK_MS);
  const event = taskEventsOf(db);
  const attemptCount = sql`(select count(*)::int from ${schema.taskEvents} where ${schema.taskEvents.taskId} = ${schema.tasks.id} and ${schema.taskEvents.eventType} = ${CANCEL_REDRIVEN_EVENT})`;
  const candidates = await db
    .select({ taskId: schema.tasks.id, attempts: sql<number>`${attemptCount}` })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'cancelled'),
        not(exists(event('task.cancel_finished'))),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.mergeDirClaims)
            .where(eq(schema.mergeDirClaims.taskId, schema.tasks.id)),
        ),
        or(
          and(
            sql`${attemptCount} >= ${CANCEL_REDRIVE_MAX}`,
            not(exists(event(CANCEL_REDRIVEN_EVENT, gte(schema.taskEvents.createdAt, cutoff)))),
          ),
          not(exists(event('task.cancelled', gt(schema.taskEvents.createdAt, since)))),
        ),
      ),
    )
    .orderBy(asc(schema.tasks.updatedAt))
    .limit(CANCEL_REDRIVE_BATCH);
  if (candidates.length === 0) return 0;

  const queued = await deps.queuedCancelTaskIds();
  if (queued === null) return 0;

  let abandoned = 0;
  for (const t of candidates) {
    if (queued.has(t.taskId)) continue;
    const reason =
      t.attempts >= CANCEL_REDRIVE_MAX
        ? 're-drive cap reached'
        : 'cancelled before the re-drive window';
    try {
      await abandonTeardown(db, t.taskId, reason);
      abandoned++;
    } catch (err) {
      log.error(
        { err, taskId: t.taskId },
        'the teardown of a cancelled task could not be abandoned',
      );
    }
  }
  return abandoned;
}

export interface RepoCleanupDeps {
  enqueueRepoCleanup: (
    kind: 'rag' | 'resources',
    payload: RepoRagCleanupPayload | RepoResourceCleanupPayload,
    jobId: string,
  ) => Promise<void>;
}

export const defaultRepoCleanupDeps: RepoCleanupDeps = { enqueueRepoCleanup };

export const REPO_CLEANUP_STALE_MS = 10 * 60 * 1000;
/** A cleanup still standing after this many re-queues is dropped rather than looped on forever. */
export const REPO_CLEANUP_MAX_ATTEMPTS = 5;
export const REPO_CLEANUP_BATCH = 50;

/** Queues again each `repo_cleanups` row whose job was never recorded as queued or was queued
 *  before the cutoff: the worker deletes a row when its job succeeds, so a standing one is a
 *  cleanup the api never queued or one that keeps failing. The attempt is counted before the job
 *  exists, and its id carries the count and the claim's stamp, so two sweeps cannot queue one attempt
 *  twice and an attempt counted again after a refund gets a fresh id. */
export async function redriveRepoCleanups(
  db: Database,
  deps: RepoCleanupDeps = defaultRepoCleanupDeps,
  opts: { staleMs: number } = { staleMs: REPO_CLEANUP_STALE_MS },
): Promise<number> {
  const cutoff = new Date(Date.now() - opts.staleMs);
  const rows = await db
    .select()
    .from(schema.repoCleanups)
    // A row the api has not stamped yet counts from its creation, so the sweep leaves the api's
    // own enqueue its turn instead of racing it.
    .where(
      or(
        and(isNull(schema.repoCleanups.lastEnqueuedAt), lt(schema.repoCleanups.createdAt, cutoff)),
        lt(schema.repoCleanups.lastEnqueuedAt, cutoff),
      ),
    )
    .orderBy(asc(schema.repoCleanups.createdAt))
    .limit(REPO_CLEANUP_BATCH);

  let queued = 0;
  for (const row of rows) {
    try {
      // Every write below is a compare-and-swap on the stamp this sweep read.
      const sameStamp = row.lastEnqueuedAt
        ? eq(schema.repoCleanups.lastEnqueuedAt, row.lastEnqueuedAt)
        : isNull(schema.repoCleanups.lastEnqueuedAt);
      if (row.attempts >= REPO_CLEANUP_MAX_ATTEMPTS) {
        await db
          .delete(schema.repoCleanups)
          .where(
            and(
              eq(schema.repoCleanups.id, row.id),
              eq(schema.repoCleanups.attempts, row.attempts),
              sameStamp,
            ),
          );
        log.warn(
          { cleanupId: row.id, repositoryId: row.repositoryId, kind: row.kind },
          'repo cleanup dropped after repeated attempts; what it would have removed is left behind',
        );
        continue;
      }
      // Claimed on the stamp, so two sweeps never both queue it. The attempt is counted with the
      // claim, before the job can run and refund it, and given back if the queue refuses the job.
      const stamp = new Date();
      const claimed = await db
        .update(schema.repoCleanups)
        .set({ lastEnqueuedAt: stamp, attempts: row.attempts + 1 })
        .where(and(eq(schema.repoCleanups.id, row.id), sameStamp))
        .returning({ id: schema.repoCleanups.id });
      if (claimed.length === 0) continue;
      const attempt = row.attempts + 1;
      const kind = row.kind === 'rag' ? 'rag' : 'resources';
      try {
        await deps.enqueueRepoCleanup(
          kind,
          {
            ...(row.payload as RepoRagCleanupPayload | RepoResourceCleanupPayload),
            cleanupId: row.id,
            claimStamp: stamp.toISOString(),
          },
          // The stamp keeps ids unique when a refunded attempt is counted again.
          `repo-cleanup-${row.id}-${attempt}-${stamp.getTime()}`,
        );
      } catch (err) {
        await db
          .update(schema.repoCleanups)
          .set({ lastEnqueuedAt: row.lastEnqueuedAt, attempts: row.attempts })
          .where(
            and(eq(schema.repoCleanups.id, row.id), eq(schema.repoCleanups.lastEnqueuedAt, stamp)),
          );
        throw err;
      }
      queued++;
      log.info({ cleanupId: row.id, kind, attempt }, 'queued the cleanup of a deleted repository');
    } catch (err) {
      log.error({ err, cleanupId: row.id }, 'repo cleanup could not be queued');
    }
  }
  return queued;
}

export interface StalledTaskSweeperOptions {
  db: Database;
  intervalMs?: number;
  staleMs?: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_STALE_MS = 300_000;

export class StalledTaskSweeper {
  private readonly db: Database;
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private abandoning = false;

  constructor(opts: StalledTaskSweeperOptions) {
    this.db = opts.db;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.sweep()
        .catch((err) => log.warn({ err }, 'stalled task sweep failed'))
        .finally(() => {
          this.inFlight = false;
        });
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(
      { intervalMs: this.intervalMs, staleMs: this.staleMs },
      'stalled task sweeper started',
    );
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // Its dir locks wait without bound behind a merge, so the sweep never waits for the pass.
  private startAbandonPass(): void {
    if (this.abandoning) return;
    this.abandoning = true;
    abandonCancelledTeardowns(this.db, defaultCancelDeps, { staleMs: this.staleMs })
      .catch((err) => log.warn({ err }, 'abandoning cancelled task teardowns failed'))
      .finally(() => {
        this.abandoning = false;
      });
  }

  /** Exposed for deterministic tests. */
  async sweep(): Promise<{ redriven: number }> {
    let redriven = await redriveStalledTasks(this.db, defaultDeps, { staleMs: this.staleMs });
    redriven += await redriveCancelledTasks(this.db, defaultCancelDeps, { staleMs: this.staleMs });
    this.startAbandonPass();
    redriven += await redriveRepoCleanups(this.db);
    await reconcileStrandedSyncingBundles(this.db);
    return { redriven };
  }
}
