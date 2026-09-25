import { and, eq, exists, inArray, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, TASK_JOB_NAMES } from '@haive/shared';
import {
  enqueueAdvance,
  finishFailedStep,
  getTaskQueue,
  retrying,
  REDRIVE_RETRY_DELAYS_MS,
} from './task-queue.js';

/**
 * Catches what reconcileOrphanedSteps cannot: a step its own re-drive enqueue failed to queue,
 * or any hand-off lost between boots, left `pending`/missing, finished with nothing after it, or
 * failed with the task still running.
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
  /** Every task id a task-queue job still owes a step, or null when the queue could not be read. */
  queuedTaskIds: () => Promise<Set<string> | null>;
  redriveRetryDelaysMs?: number[];
}

/** The tasks these jobs still owe a step. A START owes none: it only claims a task still waiting
 *  to start, so one a dead worker left `active` under its lock must not hold a running task. */
export function taskIdsOwedAStep(jobs: readonly ({ name?: string; data?: unknown } | undefined)[]) {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (job?.name === TASK_JOB_NAMES.START) continue;
    const id = (job?.data as { taskId?: unknown } | undefined)?.taskId;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/** 'active' is redelivered; 'delayed' covers a holdStepAdvance, admission, or PAUSE park. */
async function readTaskQueueTaskIds(): Promise<Set<string> | null> {
  try {
    const jobs = await getTaskQueue().getJobs([
      'active',
      'waiting',
      'waiting-children',
      'delayed',
      'prioritized',
    ]);
    return taskIdsOwedAStep(jobs);
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
  queuedTaskIds: readTaskQueueTaskIds,
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

/** One pass: re-drives each running task whose current step row is missing, pending and not
 *  parked, or finished, and fails one whose current row failed, while the task queue holds no job
 *  for it. */
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
        isNotNull(schema.tasks.currentStepId),
        lt(schema.tasks.updatedAt, cutoff),
        or(
          isNull(schema.taskSteps.id),
          redrivableRow(cutoff),
          and(eq(schema.taskSteps.status, 'failed'), lt(schema.taskSteps.updatedAt, cutoff)),
        ),
      ),
    );
  if (candidates.length === 0) return 0;

  const queued = await deps.queuedTaskIds();
  if (queued === null) return 0;

  let redriven = 0;
  for (const c of candidates) {
    if (c.stepId === null) continue; // excluded by isNotNull above; narrows the type
    if (queued.has(c.taskId)) continue;
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
  return redriven;
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

  /** Exposed for deterministic tests. */
  async sweep(): Promise<{ redriven: number }> {
    const redriven = await redriveStalledTasks(this.db, defaultDeps, { staleMs: this.staleMs });
    return { redriven };
  }
}
