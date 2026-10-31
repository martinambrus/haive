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
import {
  reconcileStrandedCloningRepos,
  reconcileStrandedSyncingBundles,
} from '../data-migrations.js';
import { resyncAfterTaskEnd } from '../project-state/set-aside.js';
import { supersedeTaskRuns } from '../sandbox/cli-sandbox-fence.js';
import { killCliSandboxesForTask, listCliSandboxesForTask } from '../sandbox/sandbox-kill.js';
import { recordLeftOpenMerges } from '../step-engine/left-open-merge.js';
import { releaseTaskMergeClaims } from '../step-engine/merge-dir-claim.js';
import { discardPlanMerge } from '../step-engine/steps/plan/01-plan-merge.js';
import {
  enqueueCancel,
  enqueueRedrive,
  enqueueRepoCleanup,
  enqueueStart,
  finishFailedStep,
  getTaskQueue,
  readQueuedInvocationIds,
  recoverParkedStep,
  retrying,
  REDRIVE_RETRY_DELAYS_MS,
  stepAdvanceHeld,
} from './task-queue.js';

/**
 * Catches what reconcileOrphanedSteps cannot: a step its own re-drive enqueue failed to queue,
 * or any hand-off lost between boots, left `pending`/missing/answered, finished with nothing after it, or
 * failed with the task still running; a park whose poll chain was lost; a step left `running` that
 * no job drives; a task queued to start whose START was lost; and a step parked on a run whose
 * cli-exec job was; and a cancelled task whose teardown never finished.
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
  /** Whether a pass of this process is on the step; defaults to the task worker's own hold. */
  stepHeld?: (taskId: string, stepId: string, round: number) => boolean;
  redriveRetryDelaysMs?: number[];
}

export interface TaskQueueOwed {
  /** Tasks a job still owes a step. A START owes none to a lost hand-off: it only claims a task
   *  still waiting to start, so one a dead worker left `active` under its lock must not hold a
   *  task whose hand-off was lost. */
  steps: Set<string>;
  /** Tasks a START is still queued for. It does hold a task parked or running on its first step,
   *  which the job runs itself or hands to an advance. */
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
  enqueueAdvance: enqueueRedrive,
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

/** A current row that shows the task's hand-off was lost: pending or an answered form, unparked, or
 *  finished (a job that died between the row's end and pointing the task on), idle since `cutoff`. */
export function redrivableRow(cutoff: Date) {
  return and(
    lt(schema.taskSteps.updatedAt, cutoff),
    or(
      and(
        inArray(schema.taskSteps.status, ['pending', 'waiting_form']),
        isNull(schema.taskSteps.waitingStartedAt),
      ),
      inArray(schema.taskSteps.status, ['done', 'skipped']),
    ),
  )!;
}

/** A saved answer its advance never followed: the one row a waiting_user or waiting_pr task is taken for. */
function answeredFormRow(cutoff: Date) {
  return and(eq(schema.taskSteps.status, 'waiting_form'), redrivableRow(cutoff))!;
}

/** A park whose poll chain has stopped. The chain (15 s runtime slot, 30 s pause, 5 s module schema)
 *  rewrites the row's updated_at on every tick, so a parked row idle since `cutoff` has no chain
 *  behind it; the task's own stamp says nothing, since a tick that finds the pointer right never
 *  writes it. */
function overduePark(cutoff: Date) {
  return and(
    lt(schema.taskSteps.updatedAt, cutoff),
    eq(schema.taskSteps.status, 'pending'),
    isNotNull(schema.taskSteps.waitingStartedAt),
  )!;
}

/** A row re-opened as `running` (a Resume, retry_ai, the allowance auto-resume) whose advance never
 *  reached the queue: the re-open commits before the add, so a rejected add leaves the row as it is
 *  now. Idle since `cutoff` is not enough, since a fan-out behind queued agents sits idle too: the
 *  candidate read and the fence rule those out with the same `liveRun` expression; the fence
 *  re-reads it in the statement that bumps the epoch. */
function idleRunningRow(cutoff: Date) {
  return and(
    lt(schema.taskSteps.updatedAt, cutoff),
    eq(schema.taskSteps.status, 'running'),
    not(liveRun),
  )!;
}

/** A run of the row that has not ended, started or not: something to wait for. */
const liveRun = sql`EXISTS (SELECT 1 FROM ${schema.cliInvocations}
  WHERE ${schema.cliInvocations.taskStepId} = ${schema.taskSteps.id}
    AND ${schema.cliInvocations.endedAt} IS NULL
    AND ${schema.cliInvocations.supersededAt} IS NULL)`;

/** The current rows the sweep takes for a `running` task, apart from a failed one. */
function stalledRow(cutoff: Date) {
  return or(redrivableRow(cutoff), overduePark(cutoff), idleRunningRow(cutoff))!;
}

/** Idle since `cutoff`, or waiting_pr, which the pull-request poller rewrites every few minutes. */
function taskStale(cutoff: Date) {
  return or(lt(schema.tasks.updatedAt, cutoff), eq(schema.tasks.status, 'waiting_pr'))!;
}

interface StalledCandidate {
  taskId: string;
  userId: string;
  taskStatus: (typeof schema.tasks.$inferSelect)['status'];
  stepId: string;
  round: number;
  epoch: number;
  rowStatus?: (typeof schema.taskSteps.$inferSelect)['status'] | null;
  rowWaitingStartedAt?: Date | null;
}

/** What a candidate's current row looks like. `running` and `parked` are what a live pass leaves. */
function rowShape(c: Pick<StalledCandidate, 'rowStatus' | 'rowWaitingStartedAt'>) {
  if (c.rowStatus === 'running') return 'running';
  return c.rowStatus === 'pending' && c.rowWaitingStartedAt ? 'parked' : 'handoff';
}

/** Locks the rows (an answered form's first), then re-checks the whole candidate predicate before
 *  bumping the epoch: a step a pass claimed since the candidate read is left to that pass. */
async function redriveTask(
  db: Database,
  c: StalledCandidate,
  deps: StalledRedriveDeps,
  cutoff: Date,
): Promise<boolean> {
  const answered = c.taskStatus !== 'running';
  const fenced = await db.transaction(async (tx) => {
    const rowKey = and(
      eq(schema.taskSteps.taskId, c.taskId),
      eq(schema.taskSteps.stepId, c.stepId),
      eq(schema.taskSteps.round, c.round),
    );
    const currentRow = (cond: SQLWrapper | undefined) =>
      tx
        .select({ one: sql`1` })
        .from(schema.taskSteps)
        .where(and(rowKey, cond));
    // A Retry takes the step row before the task's, so an answered form's row is locked first.
    if (answered && (await currentRow(answeredFormRow(cutoff)).for('update')).length === 0) {
      return null;
    }
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
          eq(schema.tasks.status, c.taskStatus),
          isNull(schema.tasks.deadAt),
          eq(schema.tasks.orchestrationEpoch, c.epoch),
          sql`${schema.tasks.currentStepId} IS NOT DISTINCT FROM ${c.stepId}`,
          eq(schema.tasks.currentRound, c.round),
          taskStale(cutoff),
          answered
            ? exists(currentRow(answeredFormRow(cutoff)))
            : not(exists(currentRow(not(stalledRow(cutoff))))),
        ),
      )
      .returning({ epoch: schema.tasks.orchestrationEpoch });
    // The row's stamp throttles the next re-drive: a waiting_pr task's own is rewritten by the poller.
    if (row && answered) {
      await tx.update(schema.taskSteps).set({ updatedAt: new Date() }).where(rowKey);
    }
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
    { taskId: c.taskId, stepId: c.stepId, round: c.round, epoch: fenced.epoch, shape: rowShape(c) },
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
 *  parked, parked with a heartbeat older than the cutoff, running with no run left to wait for,
 *  an answered form, or finished, and a task waiting on a person or a pull request whose
 *  current form was answered; fails a running task whose current row failed; queues a START
 *  for a task still queued to start; and recovers a parked
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
      taskStatus: schema.tasks.status,
      rowId: schema.taskSteps.id,
      rowStatus: schema.taskSteps.status,
      rowWaitingStartedAt: schema.taskSteps.waitingStartedAt,
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
        isNull(schema.tasks.deadAt),
        isNotNull(schema.tasks.currentStepId),
        taskStale(cutoff),
        or(
          and(
            eq(schema.tasks.status, 'running'),
            or(
              isNull(schema.taskSteps.id),
              stalledRow(cutoff),
              and(eq(schema.taskSteps.status, 'failed'), lt(schema.taskSteps.updatedAt, cutoff)),
            ),
          ),
          and(
            inArray(schema.tasks.status, ['waiting_user', 'waiting_pr']),
            answeredFormRow(cutoff),
          ),
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
    // A START in the queue owns a task's first step, which it runs itself (its row is `running`, and
    // an apply that writes nothing can idle past the cutoff) or hands to an advance.
    if (queued.starts.has(c.taskId) && rowShape(c) !== 'handoff') continue;
    // And a pass of this process whose job Redis lost: the queue read cannot see it, the hold can.
    if ((deps.stepHeld ?? stepAdvanceHeld)(c.taskId, c.stepId, c.round)) continue;
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
  const attemptCount = sql`(select count(*)::int from ${schema.taskEvents} where ${schema.taskEvents.taskId} = ${schema.tasks.id} and ${schema.taskEvents.eventType} = ${CANCEL_REDRIVEN_EVENT})`;
  const candidates = await db
    .select({
      taskId: schema.tasks.id,
      userId: schema.tasks.userId,
      // Nested: a single-table select list renders its own top-level columns unqualified.
      attempts: sql<number>`${attemptCount}`,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.status, 'cancelled'),
        exists(event('task.cancelled', gt(schema.taskEvents.createdAt, since))),
        not(exists(event('task.cancelled', gte(schema.taskEvents.createdAt, cutoff)))),
        not(exists(event('task.cancel_finished'))),
        sql`${attemptCount} < ${CANCEL_REDRIVE_MAX}`,
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
      const [counted] = await db
        .insert(schema.taskEvents)
        .values({ taskId: t.taskId, eventType: CANCEL_REDRIVEN_EVENT, payload: { attempt } })
        .returning({ id: schema.taskEvents.id });
      try {
        await deps.enqueueCancel(t.taskId, t.userId);
      } catch (err) {
        // The queue refused the job, so no teardown ran: the attempt is given back.
        await db.delete(schema.taskEvents).where(eq(schema.taskEvents.id, counted!.id));
        throw err;
      }
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

async function abandonTeardown(db: Database, taskId: string, reason: string): Promise<boolean> {
  // As the CANCEL teardown does: a fixer still running may write into the dir.
  await supersedeTaskRuns(db, taskId);
  await killCliSandboxesForTask(taskId);
  const sandboxesGone = (await listCliSandboxesForTask(taskId))?.length === 0;
  if (!sandboxesGone) {
    log.warn(
      { taskId },
      'a cancelled task being abandoned still has a sandbox, or docker could not list them; its claims are kept for the next pass',
    );
    return false;
  }
  // A throw stops here, before any release: the merge is unreported and the next pass retries.
  await recordLeftOpenMerges(db, taskId);
  // Before the release, so a pass cut off below leaves only stale claims (`liveClaimHolder`).
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId: null,
    eventType: 'task.cancel_finished',
    payload: { source: 'worker', abandoned: true, reason },
  });
  const steps = [
    ['releaseTaskMergeClaims', releaseTaskMergeClaims],
    ['discardPlanMerge', discardPlanMerge],
    ['resyncAfterTaskEnd', resyncAfterTaskEnd],
  ] as const;
  // A failed step is logged, not retried: the record above already freed the dir.
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
  log.warn(
    { taskId, reason },
    'abandoned the teardown of a cancelled task; its merge dir claims no longer hold',
  );
  return true;
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
      if (await abandonTeardown(db, t.taskId, reason)) abandoned++;
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
    await reconcileStrandedCloningRepos(this.db);
    await reconcileStrandedSyncingBundles(this.db);
    return { redriven };
  }
}
