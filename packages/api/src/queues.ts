import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@haive/shared';
import { getBullRedis } from './redis.js';

export type { RepoJobPayload, TaskJobPayload } from '@haive/shared';

let repoQueue: Queue | null = null;
let taskQueue: Queue | null = null;

export function getRepoQueue(): Queue {
  if (!repoQueue) {
    repoQueue = new Queue(QUEUE_NAMES.REPO, { connection: getBullRedis() });
  }
  return repoQueue;
}

export function getTaskQueue(): Queue {
  if (!taskQueue) {
    taskQueue = new Queue(QUEUE_NAMES.TASK, { connection: getBullRedis() });
  }
  return taskQueue;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([repoQueue?.close(), taskQueue?.close()]);
  repoQueue = null;
  taskQueue = null;
}
