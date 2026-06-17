import { Queue, QueueEvents } from 'bullmq';
import { QUEUE_NAMES } from '@haive/shared';
import { getBullRedis } from './redis.js';

export type { RepoJobPayload, TaskJobPayload, BundleJobPayload } from '@haive/shared';

let repoQueue: Queue | null = null;
let taskQueue: Queue | null = null;
let cliExecQueue: Queue | null = null;
let cliExecQueueEvents: QueueEvents | null = null;
let bundleQueue: Queue | null = null;
let globalKbSyncQueue: Queue | null = null;
let runtimeEnsureQueue: Queue | null = null;
let runtimeEnsureQueueEvents: QueueEvents | null = null;

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

export function getCliExecQueue(): Queue {
  if (!cliExecQueue) {
    cliExecQueue = new Queue(QUEUE_NAMES.CLI_EXEC, { connection: getBullRedis() });
  }
  return cliExecQueue;
}

export function getCliExecQueueEvents(): QueueEvents {
  if (!cliExecQueueEvents) {
    cliExecQueueEvents = new QueueEvents(QUEUE_NAMES.CLI_EXEC, { connection: getBullRedis() });
  }
  return cliExecQueueEvents;
}

export function getBundleQueue(): Queue {
  if (!bundleQueue) {
    bundleQueue = new Queue(QUEUE_NAMES.BUNDLE, { connection: getBullRedis() });
  }
  return bundleQueue;
}

export function getGlobalKbSyncQueue(): Queue {
  if (!globalKbSyncQueue) {
    globalKbSyncQueue = new Queue(QUEUE_NAMES.GLOBAL_KB_SYNC, { connection: getBullRedis() });
  }
  return globalKbSyncQueue;
}

/** Queue + QueueEvents for the VNC "ensure runtime" handshake: the api enqueues an
 *  ensure job and awaits its result (Job.waitUntilFinished needs the QueueEvents)
 *  before bridging the VNC desktop. */
export function getRuntimeEnsureQueue(): Queue {
  if (!runtimeEnsureQueue) {
    runtimeEnsureQueue = new Queue(QUEUE_NAMES.RUNTIME_ENSURE, { connection: getBullRedis() });
  }
  return runtimeEnsureQueue;
}

export function getRuntimeEnsureQueueEvents(): QueueEvents {
  if (!runtimeEnsureQueueEvents) {
    runtimeEnsureQueueEvents = new QueueEvents(QUEUE_NAMES.RUNTIME_ENSURE, {
      connection: getBullRedis(),
    });
  }
  return runtimeEnsureQueueEvents;
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    repoQueue?.close(),
    taskQueue?.close(),
    cliExecQueue?.close(),
    cliExecQueueEvents?.close(),
    bundleQueue?.close(),
    globalKbSyncQueue?.close(),
    runtimeEnsureQueue?.close(),
    runtimeEnsureQueueEvents?.close(),
  ]);
  repoQueue = null;
  taskQueue = null;
  cliExecQueue = null;
  cliExecQueueEvents = null;
  bundleQueue = null;
  globalKbSyncQueue = null;
  runtimeEnsureQueue = null;
  runtimeEnsureQueueEvents = null;
}
