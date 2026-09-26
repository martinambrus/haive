import type { Job, Queue } from 'bullmq';
import { CLI_EXEC_JOB_NAMES, logger } from '@haive/shared';
import { getRedis } from '../redis.js';

const log = logger.child({ module: 'boot-requeue' });

/** A requeue never counts toward BullMQ's `maxStalledCount`, so a job that kills the worker would
 *  come back at every boot; past this many it is left to its lock and BullMQ's own count. */
export const BOOT_REQUEUE_LIMIT = 3;
const COUNT_TTL_S = 24 * 60 * 60;

const CLI_EXEC_REQUEUED_AT_BOOT: ReadonlySet<string> = new Set([
  CLI_EXEC_JOB_NAMES.INVOKE,
  CLI_EXEC_JOB_NAMES.REFRESH_VERSIONS,
]);

/** The cli-exec kinds known safe to run again at once; the rest wait out their lock as before. */
export function cliExecJobRequeuedAtBoot(job: { name: string }): boolean {
  return CLI_EXEC_REQUEUED_AT_BOOT.has(job.name);
}

export async function countBootRequeue(key: string): Promise<number> {
  const redis = getRedis();
  const count = await redis.incr(key);
  await redis.expire(key, COUNT_TTL_S);
  return count;
}

/** Moves the active jobs of a worker that died back to waiting, so the next worker runs them now
 *  rather than once their lock expires. Only while no worker is connected, since a live one may
 *  still be running them. */
export async function requeueOrphanedActiveJobs<T>(
  queue: Queue<T>,
  accept: (job: Job<T>) => boolean,
  count: (key: string) => Promise<number> = countBootRequeue,
): Promise<number> {
  let jobs: (Job<T> | undefined)[];
  try {
    const workers = await queue.getWorkersCount();
    if (workers > 0) {
      log.info(
        { queue: queue.name, workers },
        'a worker is connected; leaving active jobs to their locks',
      );
      return 0;
    }
    jobs = await queue.getJobs(['active']);
  } catch (err) {
    log.warn({ err, queue: queue.name }, 'queue unreadable; leaving active jobs to their locks');
    return 0;
  }
  let moved = 0;
  for (const job of jobs) {
    if (!job?.id || !accept(job)) continue;
    try {
      const requeues = await count(`haive:boot-requeue:${queue.name}:${job.id}:${job.timestamp}`);
      if (requeues > BOOT_REQUEUE_LIMIT) {
        log.warn(
          { queue: queue.name, jobId: job.id, name: job.name, requeues },
          'active job was requeued at every recent boot; leaving it to its lock',
        );
        continue;
      }
      await job.moveToWait('0');
      moved += 1;
    } catch (err) {
      log.warn({ err, queue: queue.name, jobId: job.id }, 'could not requeue an active job');
    }
  }
  if (moved > 0) log.info({ queue: queue.name, moved }, 'requeued active jobs a dead worker held');
  return moved;
}
