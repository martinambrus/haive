import { Queue, Worker } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import {
  CONFIG_KEYS,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  configService,
  logger,
  type TaskJobPayload,
} from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import { ForgeRateLimitError, resolveForgeContext, resolveForgeProvider } from '../forge/index.js';

const log = logger.child({ module: 'pr-poll' });

// PRs merge on a human timescale, so a few minutes' detection lag is fine. The
// repeatable tick is the only trigger — unlike usage-poll there is no per-open
// one-off, because first-check latency does not matter for PR review.
const POLL_INTERVAL_MS = 3 * 60 * 1000;
const POLL_JOB_ID = 'pr-poll-tick-repeatable';
const POLL_JOB_NAME = 'pr-poll-tick';
const POLL_CONCURRENCY = 4;
const BACKOFF_BASE_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Per-host 429 backoff, kept in-process (the poll worker is a singleton, cleared on
 *  restart where a fresh boot poll is fine). */
const backoff = new Map<string, { until: number; strikes: number }>();

function isBackingOff(host: string): boolean {
  const b = backoff.get(host);
  return b != null && Date.now() < b.until;
}
function noteRateLimit(host: string, retryAfterMs?: number): void {
  const strikes = (backoff.get(host)?.strikes ?? 0) + 1;
  const base = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : BACKOFF_BASE_MS * strikes;
  backoff.set(host, { until: Date.now() + Math.min(base, BACKOFF_MAX_MS), strikes });
}
function clearBackoff(host: string): void {
  backoff.delete(host);
}

let queueSingleton: Queue | null = null;
function getPrPollQueue(): Queue {
  if (!queueSingleton) {
    queueSingleton = new Queue(QUEUE_NAMES.PR_POLL, { connection: getBullRedis() });
  }
  return queueSingleton;
}

let taskQueueSingleton: Queue<TaskJobPayload> | null = null;
function getTaskQueue(): Queue<TaskJobPayload> {
  if (!taskQueueSingleton) {
    taskQueueSingleton = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, {
      connection: getBullRedis(),
    });
  }
  return taskQueueSingleton;
}

/** Idempotent: upsertJobScheduler keys on POLL_JOB_ID so a restart updates the one
 *  scheduler; the pre-sweep clears any orphaned legacy repeatable. */
export async function schedulePrPollTick(): Promise<void> {
  const queue = getPrPollQueue();
  for (const r of await queue.getRepeatableJobs().catch(() => [])) {
    await queue.removeRepeatableByKey(r.key).catch(() => {});
  }
  await queue.upsertJobScheduler(
    POLL_JOB_ID,
    { every: POLL_INTERVAL_MS },
    { name: POLL_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: 10 } },
  );
}

export function startPrPollWorker(): Worker {
  return new Worker(
    QUEUE_NAMES.PR_POLL,
    async () => {
      await runPrPollTick(getDb());
    },
    { connection: getBullRedis(), concurrency: 1 },
  );
}

interface PrWaitTask {
  id: string;
  userId: string;
  repositoryId: string | null;
  prProvider: string | null;
  prNumber: string | null;
  prUrl: string | null;
  prState: string | null;
  prFinalizeMode: string | null;
  prCredentialId: string | null;
}

async function runPrPollTick(db: Database): Promise<void> {
  if (!(await configService.getBoolean(CONFIG_KEYS.PR_WORKFLOW_ENABLED, false))) return;
  // Every parked PR-wait task, not just prState='open': a task already flipped to
  // 'merged' but still parked means a prior auto-advance was lost — re-drive it. A
  // completed task is no longer 'waiting_pr', so it drops out of this set.
  const tasks = (await db.query.tasks.findMany({
    where: eq(schema.tasks.status, 'waiting_pr'),
    columns: {
      id: true,
      userId: true,
      repositoryId: true,
      prProvider: true,
      prNumber: true,
      prUrl: true,
      prState: true,
      prFinalizeMode: true,
      prCredentialId: true,
    },
  })) as PrWaitTask[];
  if (tasks.length === 0) return;
  for (let i = 0; i < tasks.length; i += POLL_CONCURRENCY) {
    await Promise.allSettled(tasks.slice(i, i + POLL_CONCURRENCY).map((t) => pollTask(db, t)));
  }
}

async function pollTask(db: Database, task: PrWaitTask): Promise<void> {
  // Already merged (auto mode) but still parked — a prior auto-advance was lost; re-drive.
  if (task.prState === 'merged') {
    if (task.prFinalizeMode !== 'manual') await advancePrWaitStep(db, task);
    return;
  }
  // Closed without merging is surfaced in the UI; the user decides. Nothing to poll.
  if (task.prState === 'closed') return;

  if (!task.repositoryId || !task.prNumber || !task.prCredentialId) {
    await recordPollError(db, task.id, 'missing repository, PR number, or credential for polling');
    return;
  }
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { remoteUrl: true },
  });
  if (!repo?.remoteUrl) {
    await recordPollError(db, task.id, 'repository has no remote URL to poll the pull request');
    return;
  }

  let host = '';
  try {
    const forgeCtx = await resolveForgeContext({
      db,
      userId: task.userId,
      credentialId: task.prCredentialId,
      remoteUrl: repo.remoteUrl,
    });
    host = forgeCtx.host;
    if (isBackingOff(host)) return;
    const state = await resolveForgeProvider(forgeCtx.provider).getPullRequestState(
      forgeCtx,
      task.prNumber,
    );
    clearBackoff(host);

    if (state.state === 'open') {
      await db
        .update(schema.tasks)
        .set({ prPollError: null, updatedAt: new Date() })
        .where(eq(schema.tasks.id, task.id));
      return;
    }
    if (state.state === 'merged') {
      await db
        .update(schema.tasks)
        .set({
          prState: 'merged',
          prMergedAt: state.mergedAt ?? new Date(),
          prPollError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, task.id));
      log.info({ taskId: task.id, prUrl: task.prUrl }, 'pull request merged');
      if (task.prFinalizeMode !== 'manual') await advancePrWaitStep(db, task);
      return;
    }
    // closed without merging
    await db
      .update(schema.tasks)
      .set({ prState: 'closed', prPollError: null, updatedAt: new Date() })
      .where(eq(schema.tasks.id, task.id));
    log.info({ taskId: task.id, prUrl: task.prUrl }, 'pull request closed without merging');
  } catch (err) {
    if (err instanceof ForgeRateLimitError && host) noteRateLimit(host, err.retryAfterMs);
    await recordPollError(db, task.id, err instanceof Error ? err.message : String(err));
  }
}

async function recordPollError(db: Database, taskId: string, message: string): Promise<void> {
  await db
    .update(schema.tasks)
    .set({ prPollError: message.slice(0, 1000), updatedAt: new Date() })
    .where(eq(schema.tasks.id, taskId));
  log.warn({ taskId, error: message }, 'pull-request poll failed');
}

/** Auto-finalize on merge: submit the parked 13-pr-wait form so the step's apply reaps
 *  the worktree and the task completes. Mirrors the API submit path (write formValues +
 *  enqueue ADVANCE_STEP); epoch is omitted so the orchestration-epoch guard never
 *  falsely skips it. Idempotent — a no-op once the step is no longer parked. */
async function advancePrWaitStep(db: Database, task: PrWaitTask): Promise<void> {
  const stepRow = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, task.id),
      eq(schema.taskSteps.stepId, '13-pr-wait'),
      eq(schema.taskSteps.status, 'waiting_form'),
    ),
    orderBy: [desc(schema.taskSteps.round)],
    columns: { id: true, round: true },
  });
  if (!stepRow) return;
  await db
    .update(schema.taskSteps)
    .set({ formValues: {}, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, stepRow.id));
  await getTaskQueue().add(
    TASK_JOB_NAMES.ADVANCE_STEP,
    {
      taskId: task.id,
      userId: task.userId,
      stepId: '13-pr-wait',
      round: stepRow.round,
      formValues: {},
    },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
  log.info({ taskId: task.id }, 'auto-finalizing the PR-wait step on merge');
}

export async function closePrPollQueue(): Promise<void> {
  if (queueSingleton) {
    await queueSingleton.close();
    queueSingleton = null;
  }
  if (taskQueueSingleton) {
    await taskQueueSingleton.close();
    taskQueueSingleton = null;
  }
}
