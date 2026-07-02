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
let ideEnsureQueue: Queue | null = null;
let ideEnsureQueueEvents: QueueEvents | null = null;
let ddevControlQueue: Queue | null = null;
let ddevControlQueueEvents: QueueEvents | null = null;

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

/** Queue + QueueEvents for the Editor-tab "ensure IDE" handshake: the api enqueues
 *  an ensure job when the user opens the editor and awaits its result before
 *  proxying to the code-server container. */
export function getIdeEnsureQueue(): Queue {
  if (!ideEnsureQueue) {
    ideEnsureQueue = new Queue(QUEUE_NAMES.IDE_ENSURE, { connection: getBullRedis() });
  }
  return ideEnsureQueue;
}

export function getIdeEnsureQueueEvents(): QueueEvents {
  if (!ideEnsureQueueEvents) {
    ideEnsureQueueEvents = new QueueEvents(QUEUE_NAMES.IDE_ENSURE, {
      connection: getBullRedis(),
    });
  }
  return ideEnsureQueueEvents;
}

/** Queue + QueueEvents for the ddev-control MCP: the api enqueues a status/logs/restart
 *  job (from the sandbox MCP call) and awaits the worker's result before responding. */
export function getDdevControlQueue(): Queue {
  if (!ddevControlQueue) {
    ddevControlQueue = new Queue(QUEUE_NAMES.DDEV_CONTROL, { connection: getBullRedis() });
  }
  return ddevControlQueue;
}

export function getDdevControlQueueEvents(): QueueEvents {
  if (!ddevControlQueueEvents) {
    ddevControlQueueEvents = new QueueEvents(QUEUE_NAMES.DDEV_CONTROL, {
      connection: getBullRedis(),
    });
  }
  return ddevControlQueueEvents;
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
    ideEnsureQueue?.close(),
    ideEnsureQueueEvents?.close(),
    ddevControlQueue?.close(),
    ddevControlQueueEvents?.close(),
  ]);
  repoQueue = null;
  taskQueue = null;
  cliExecQueue = null;
  cliExecQueueEvents = null;
  bundleQueue = null;
  globalKbSyncQueue = null;
  runtimeEnsureQueue = null;
  runtimeEnsureQueueEvents = null;
  ideEnsureQueue = null;
  ideEnsureQueueEvents = null;
  ddevControlQueue = null;
  ddevControlQueueEvents = null;
}
