/**
 * Boot hands a dead worker's active jobs back at once, against a real Redis. Each scenario uses its
 * own throwaway queue, obliterated after, with the requeue counters it wrote.
 */
import { randomBytes } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { CLI_EXEC_JOB_NAMES, createBullRedisConnection, logger } from '@haive/shared';
import { getRedis, initRedis } from '../src/redis.js';
import {
  BOOT_REQUEUE_LIMIT,
  cliExecJobRequeuedAtBoot,
  requeueOrphanedActiveJobs,
} from '../src/queues/boot-requeue.js';

const log = logger.child({ module: 'boot-requeue-smoke' });

if (!process.env.REDIS_URL) {
  console.error('[smoke] missing env REDIS_URL');
  process.exit(2);
}
const url = process.env.REDIS_URL;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connections: Redis[] = [];
const queues: Queue[] = [];

function connection(): Redis {
  const c = createBullRedisConnection(url);
  connections.push(c);
  return c;
}

function newQueue(): Queue {
  const q = new Queue(`boot-requeue-smoke-${randomBytes(4).toString('hex')}`, {
    connection: connection(),
  });
  queues.push(q);
  return q;
}

/** A worker that takes jobs and never finishes them, as one that dies mid-job does. */
async function holdingWorker(queue: Queue, concurrency: number, expected: number): Promise<Worker> {
  let started = 0;
  const worker = new Worker(queue.name, () => new Promise<void>(() => void (started += 1)), {
    connection: connection(),
    concurrency,
    lockDuration: 30 * 60 * 1000,
  });
  worker.on('error', () => {});
  for (let i = 0; i < 100 && started < expected; i += 1) await sleep(50);
  return worker;
}

/** Redis lists a force-closed worker for a moment after close() resolves; a process that died
 *  before this one booted is long gone. */
async function workerDiesHolding(
  queue: Queue,
  concurrency: number,
  expected: number,
): Promise<void> {
  await (await holdingWorker(queue, concurrency, expected)).close(true);
  for (let i = 0; i < 100 && (await queue.getWorkersCount()) > 0; i += 1) await sleep(50);
}

function recordingWorker(queue: Queue, seen: string[]): Worker {
  const worker = new Worker(
    queue.name,
    async (job: Job) => {
      seen.push(job.name);
    },
    { connection: connection() },
  );
  worker.on('error', () => {});
  return worker;
}

async function stateOf(queue: Queue, id: string | undefined): Promise<string> {
  const job = id ? await queue.getJob(id) : undefined;
  return job ? await job.getState() : 'missing';
}

async function main(): Promise<void> {
  initRedis(url);
  try {
    // A dead worker's jobs: an agent run and a probe, which boot leaves to its lock.
    const q1 = newQueue();
    const invoke = await q1.add(CLI_EXEC_JOB_NAMES.INVOKE, {}, { removeOnComplete: false });
    const probe = await q1.add(CLI_EXEC_JOB_NAMES.PROBE, {}, { removeOnComplete: false });
    await workerDiesHolding(q1, 2, 2);
    check('both jobs are active after their worker died', (await q1.getActiveCount()) === 2);
    check('no worker is connected once it died', (await q1.getWorkersCount()) === 0);

    const before: string[] = [];
    const idle = recordingWorker(q1, before);
    await sleep(3000);
    await idle.close();
    check(
      'without a requeue the next worker runs nothing for as long as the lock holds',
      before.length === 0,
      before,
    );

    const moved = await requeueOrphanedActiveJobs(q1, cliExecJobRequeuedAtBoot);
    check('the requeue moves the agent run only', moved === 1, moved);
    const after: string[] = [];
    const next = recordingWorker(q1, after);
    for (let i = 0; i < 100 && after.length === 0; i += 1) await sleep(50);
    await sleep(300);
    await next.close();
    check(
      'the next worker runs the requeued job at once',
      after.join() === CLI_EXEC_JOB_NAMES.INVOKE,
      after,
    );
    check(
      'the requeued job completes under its new lock',
      (await stateOf(q1, invoke.id)) === 'completed',
    );
    check('the probe is left active on its lock', (await stateOf(q1, probe.id)) === 'active');

    // A live worker still running its job: nothing moves.
    const q2 = newQueue();
    const owned = await q2.add('owned', {}, { removeOnComplete: false });
    const owner = await holdingWorker(q2, 1, 1);
    check('a live worker is counted', (await q2.getWorkersCount()) === 1);
    check(
      'nothing moves while a worker is connected',
      (await requeueOrphanedActiveJobs(q2, () => true)) === 0,
    );
    check('its job stays active', (await stateOf(q2, owned.id)) === 'active');
    await owner.close(true);

    // One job that keeps dying with its worker is requeued only so many times.
    const q3 = newQueue();
    const poison = await q3.add('poison', {}, { removeOnComplete: false });
    const results: number[] = [];
    for (let i = 0; i <= BOOT_REQUEUE_LIMIT; i += 1) {
      await workerDiesHolding(q3, 1, 1);
      results.push(await requeueOrphanedActiveJobs(q3, () => true));
    }
    check(
      'a job is requeued at the first boots and then left to its lock',
      results.join() === [...Array(BOOT_REQUEUE_LIMIT).fill(1), 0].join(),
      results,
    );
    check('the job left to its lock stays active', (await stateOf(q3, poison.id)) === 'active');

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'BOOT_REQUEUE_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      for (const q of queues) {
        await q.obliterate({ force: true });
        const keys = await getRedis().keys(`haive:boot-requeue:${q.name}:*`);
        if (keys.length > 0) await getRedis().del(...keys);
        await q.close();
      }
      await Promise.allSettled(connections.map((c) => c.quit()));
      await getRedis().quit();
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
