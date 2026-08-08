import type { Job } from 'bullmq';
import { CLI_EXEC_JOB_NAMES, logger, type CliExecJobPayload } from '@haive/shared';
import { repricedPriority } from '@haive/shared/fair-priority';
import { getCliExecQueue } from '../queues.js';

/** BullMQ v5 spreads a task's not-yet-running invocations across THREE states, and a vote has
 *  to reach all of them:
 *   - `prioritized` — where fair scheduling actually puts them (it sets opts.priority, and a
 *     job with a priority never enters `waiting`; scanning `waiting` alone silently finds zero)
 *   - `waiting` — the fallback when fair scheduling is switched off
 *   - `delayed` — jobs parked by a pickup gate (pause / per-task cap / runtime-holder reserve)
 *
 *  `delayed` is included because changePriority writes the new value onto the job hash whether
 *  or not the job is currently in a sortable list, and the delayed-set promotion reads it back
 *  — so a deferred job picks up the boost when it redelivers. */
const QUEUED_STATES = ['waiting', 'prioritized', 'delayed'] as const;

/** Deep enough to find a task's queued jobs on any realistic queue; a deeper scan cannot
 *  change the outcome, only its cost. */
const SCAN_LIMIT = 1000;

/**
 * Re-price the cli-exec jobs a task has already queued, after its vote score moved by
 * `scoreDelta`.
 *
 * Without this a vote would only affect invocations enqueued AFTER it, which is exactly the
 * wrong half: the reason to boost a task is the work it is already waiting to run. Shifting by
 * whole bands is exact (see repricedPriority), so no job has to carry its original rank.
 *
 * Best-effort by design. A job that finishes, starts, or is removed mid-scan simply misses the
 * reprice, and the next enqueue for that task reads the new score anyway — so a failure here
 * delays the boost, it never wedges the queue. Never throws.
 */
export async function repriceTaskCliJobs(taskId: string, scoreDelta: number): Promise<number> {
  if (scoreDelta === 0) return 0;
  let repriced = 0;
  try {
    const jobs = (await getCliExecQueue().getJobs(
      [...QUEUED_STATES],
      0,
      SCAN_LIMIT,
    )) as Job<CliExecJobPayload>[];
    for (const job of jobs) {
      if (job.name !== CLI_EXEC_JOB_NAMES.INVOKE) continue;
      if (job.data?.taskId !== taskId) continue;
      // `job.priority`, NOT `job.opts.priority`. Both exist, and only the first one is live:
      // changePriority updates the job hash's `priority` field, which fromJSON reads into
      // `job.priority`, but it never rewrites the serialized `opts` snapshot taken at
      // queue.add. Reading opts would make a SECOND vote on the same job recompute from the
      // pre-vote number and silently no-op.
      //
      // 0 (or NaN, on a job whose hash predates any priority) means the job was enqueued with
      // fair scheduling off, i.e. plain FIFO. Assigning a priority now would move it into
      // `prioritized` and reorder it against jobs that are deliberately unordered, so skip it.
      const current = job.priority;
      if (!current) continue;
      try {
        await job.changePriority({ priority: repricedPriority(current, scoreDelta) });
        repriced++;
      } catch (err) {
        logger.debug({ err, taskId, jobId: job.id }, 'cli-exec job reprice skipped');
      }
    }
  } catch (err) {
    logger.warn({ err, taskId }, 'cli-exec reprice scan failed; vote applies to new jobs only');
  }
  return repriced;
}
