import { and, eq, exists, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { enqueueAdvance, getTaskQueue, retrying, REDRIVE_RETRY_DELAYS_MS } from './task-queue.js';

/**
 * Catches what reconcileOrphanedSteps cannot: a step its own re-drive enqueue failed to queue,
 * or any hand-off lost between boots, left `pending`/missing with nothing to drive it.
 */

const log = logger.child({ module: 'stalled-redrive' });

export interface StalledRedriveDeps {
  enqueueAdvance: (
    taskId: string,
    userId: string,
    stepId: string,
    round: number,
    epoch: number,
  ) => Promise<void>;
  /** Every task id an advance-step job still owes, or null when the queue could not be read. */
  queuedTaskIds: () => Promise<Set<string> | null>;
  redriveRetryDelaysMs?: number[];
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
    const ids = new Set<string>();
    for (const job of jobs) {
      const id = (job?.data as { taskId?: unknown } | undefined)?.taskId;
      if (typeof id === 'string') ids.add(id);
    }
    return ids;
  } catch (err) {
    log.warn({ err }, 'task queue unreadable; leaving stalled tasks alone this pass');
    return null;
  }
}

export const defaultDeps: StalledRedriveDeps = {
  enqueueAdvance,
  queuedTaskIds: readTaskQueueTaskIds,
};

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
                    not(
                      // and() always has 3 args here, so it never returns undefined.
                      and(
                        eq(schema.taskSteps.status, 'pending'),
                        isNull(schema.taskSteps.waitingStartedAt),
                        lt(schema.taskSteps.updatedAt, cutoff),
                      )!,
                    ),
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

/** One pass: re-drives each running task whose current step row is missing, or pending and not
 *  parked, while the task queue holds no job for it. */
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
          and(
            eq(schema.taskSteps.status, 'pending'),
            isNull(schema.taskSteps.waitingStartedAt),
            lt(schema.taskSteps.updatedAt, cutoff),
          ),
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
      if (await redriveTask(db, { ...c, stepId: c.stepId }, deps, cutoff)) redriven++;
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
