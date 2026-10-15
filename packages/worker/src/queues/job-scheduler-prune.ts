import type { Queue } from 'bullmq';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'job-scheduler-prune' });

type PrunableQueue = Pick<Queue, 'name' | 'getJobSchedulers' | 'removeJobScheduler'>;

/** Removes each scheduler not in keep, with its pending job; keep must hold ALL ids upserted. */
export async function pruneJobSchedulers(
  queue: PrunableQueue,
  keep: readonly string[],
): Promise<number> {
  const owned = new Set(keep);
  let removed = 0;
  try {
    const stale = new Set<string>();
    // One read: pages ordered by next run shift while a firing scheduler re-arms.
    for (const { key } of await queue.getJobSchedulers(0, -1)) {
      if (!owned.has(key)) stale.add(key);
    }
    for (const id of stale) {
      if (await queue.removeJobScheduler(id)) removed += 1;
    }
  } catch (err) {
    log.warn({ err, queue: queue.name, removed }, 'job scheduler prune stopped early');
  }
  if (removed > 0) {
    log.info({ queue: queue.name, removed }, 'removed job schedulers this queue does not own');
  }
  return removed;
}
