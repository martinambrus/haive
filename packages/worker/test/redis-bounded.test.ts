import { once } from 'node:events';
import type { Database } from '@haive/database';
import { ReplyError } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../src/redis.js';
import { acquireAgentLease, reserveAgentSlot } from '../src/queues/cli-exec/agent-lease.js';
import { enforceAgentLaneCap } from '../src/queues/cli-exec/handlers.js';
import { requeueOrphanedActiveJobs } from '../src/queues/boot-requeue.js';
import { acquireRepoRagSyncLock } from '../src/step-engine/steps/_rag-sync-lock.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { closedPort, startFake, type Fake } from './support/redis-stall.js';

const DEADLINE = 25;
let fake: Fake | undefined;

function init(port: number) {
  const clients = client.initRedis(`redis://127.0.0.1:${port}`, { commandTimeoutMs: DEADLINE });
  clients.bullRedis.on('error', () => undefined);
  return clients;
}
async function ready() {
  if (client.getRedis().status !== 'ready') await once(client.getRedis(), 'ready');
}
function track<T>(work: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void work.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}
async function recover(): Promise<void> {
  fake!.mute = false;
  const closed = once(client.getRedis(), 'close');
  fake!.dropAll();
  await closed;
  const recovered = ready();
  await vi.advanceTimersByTimeAsync(50);
  await recovered;
}
async function stalled<T>(work: Promise<T>, command: string) {
  const state = track(work);
  await fake!.nextCommand(command);
  await vi.advanceTimersByTimeAsync(DEADLINE - 1);
  expect(state.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  // A red control settles here by assertion, without waiting for Vitest's timeout.
  expect(state.settled).toBe(true);
  return state;
}

beforeEach(() =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  }),
);
afterEach(async () => {
  if (fake) fake.mute = false;
  const closing = client.closeRedis();
  await vi.advanceTimersByTimeAsync(1_000);
  await closing;
  await fake?.stop();
  fake = undefined;
  vi.useRealTimers();
});

describe('worker Redis command bounds', () => {
  it('pins the production deadline and leaves BullMQ options patient', async () => {
    const clients = client.initRedis(`redis://127.0.0.1:${await closedPort()}`);
    clients.bullRedis.on('error', () => undefined);
    expect(client.REDIS_COMMAND_TIMEOUT_MS).toBe(2_000);
    expect(clients.redis.options.commandTimeout).toBe(client.REDIS_COMMAND_TIMEOUT_MS);
    expect(clients.redis.options.autoResendUnfulfilledCommands).toBe(false);
    expect(clients.bullRedis.options.maxRetriesPerRequest).toBeNull();
    expect(clients.bullRedis.options.commandTimeout).toBeUndefined();
    expect(clients.bullRedis.options.enableOfflineQueue).toBe(true);
    expect(clients.bullRedis.options.enableReadyCheck).toBe(false);
  });

  it('keeps blocking reads and subscriber duplicates patient beyond the finite deadline', async () => {
    fake = await startFake();
    init(fake.port);
    const patient = client.getPatientRedis();
    if (patient.status !== 'ready') await once(patient, 'ready');
    const sub = patient.duplicate();
    sub.on('error', () => undefined);
    try {
      await once(sub, 'ready');
      expect(() => client.getRedis().duplicate()).toThrow();
      expect(sub.options.commandTimeout).toBeUndefined();
      expect(sub.options.enableOfflineQueue).toBe(true);
      fake.mute = true;
      const read = track(patient.xread('BLOCK', 0, 'STREAMS', 's', '0-0'));
      await fake.nextCommand('XREAD');
      const subscribed = track(sub.subscribe('steer:inv'));
      await fake.nextCommand('SUBSCRIBE');
      await vi.advanceTimersByTimeAsync(3 * DEADLINE);
      expect(read.settled).toBe(false);
      expect(subscribed.settled).toBe(false);
    } finally {
      sub.disconnect();
    }
  });

  it('rejects without an offline queue on a refused connection', async () => {
    init(await closedPort());
    const state = track(client.getRedis().get('k'));
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(client.RedisUnavailableError);
    expect(state.error).toMatchObject({ code: 'redis_unavailable' });
    expect(
      (client.getRedis() as unknown as { offlineQueue: { length: number } }).offlineQueue.length,
    ).toBe(0);
  });

  it('rejects while the ready check remains LOADING', async () => {
    fake = await startFake();
    fake.loading = true;
    const seen = fake.nextCommand('INFO');
    init(fake.port);
    await seen;
    const state = track(client.getRedis().get('k'));
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(client.RedisUnavailableError);
    expect(state.error).toMatchObject({ code: 'redis_unavailable' });
    expect(fake.commands.filter((c) => c[0]!.toUpperCase() === 'GET')).toHaveLength(0);
  });

  it('keeps ReplyError identity distinct from transport failure', async () => {
    fake = await startFake();
    init(fake.port);
    await ready();
    await expect(client.getRedis().hset('wrongkey', 'f', 'v')).rejects.toBeInstanceOf(ReplyError);
  });

  it('bounds pipeline errors and a rejected transaction', async () => {
    init(await closedPort());
    const pending = track(client.getRedis().pipeline().set('a', '1').get('a').exec());
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(pending.settled).toBe(true);
    const pipeline = pending.value;
    expect(pipeline).toHaveLength(2);
    for (const [error] of pipeline!) expect(error).toMatchObject({ code: 'redis_unavailable' });
    await expect(client.getRedis().multi().set('a', '1').exec()).rejects.toMatchObject({
      code: 'redis_unavailable',
    });
  });

  it('never replays a timed-out write on recovery', async () => {
    fake = await startFake();
    init(fake.port);
    await ready();
    fake.mute = true;
    const state = await stalled(client.getRedis().set('k', 'v'), 'SET');
    expect(state.error).toBeInstanceOf(client.RedisUnavailableError);
    expect(state.error).toMatchObject({ code: 'redis_unavailable' });
    fake.mute = false;
    const closed = once(client.getRedis(), 'close');
    fake.dropAll();
    await closed;
    const recovered = ready();
    await vi.advanceTimersByTimeAsync(50);
    await recovered;
    expect(await client.getRedis().ping()).toBe('PONG');
    expect(fake.commands.filter((c) => c[0]!.toUpperCase() === 'SET')).toHaveLength(1);
  });
});

describe('consequential gates against a silent store', () => {
  beforeEach(async () => {
    fake = await startFake();
    init(fake.port);
    await ready();
    fake.mute = true;
  });

  it('settles INVOKE admission with its documented fail-open answer', async () => {
    const job = { id: '7', moveToDelayed: vi.fn() };
    const state = await stalled(
      enforceAgentLaneCap({} as Database, job as never, 'tok', 2),
      'EVAL',
    );
    expect(state.error).toBeUndefined();
    expect(state.value).toBeUndefined();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('keeps a step command waiting through an outage, then takes a lease', async () => {
    const waiting = acquireAgentLease(
      { db: {} as Database, agentCap: async () => 2 },
      { waitMs: 500, pollMs: 10 },
    );
    const state = track(waiting);
    await fake!.nextCommand('EVAL');
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(state.settled).toBe(false);
    await recover();
    await vi.advanceTimersByTimeAsync(10);
    await waiting;
    expect(state.error).toBeUndefined();
    expect(state.value).toBeDefined();
    const fields = fake!.commands.filter((c) => c[0]!.toUpperCase() === 'EVAL').map((c) => c[6]);
    expect(fields.length).toBeGreaterThan(1);
    expect(new Set(fields).size).toBe(1);
    await state.value?.release();
  });

  it('releases a processor after a lost HDEL answer, leaving expiry as backstop', async () => {
    fake!.mute = false;
    const slot = await reserveAgentSlot('invoke:7:tok', 2);
    expect(slot).not.toBeNull();
    fake!.mute = true;
    const state = await stalled(slot!.release(), 'HDEL');
    expect(state.error).toBeUndefined();
    await slot!.release();
  });

  it('leaves orphan jobs locked when their boot requeue counter is unreadable', async () => {
    const moveToWait = vi.fn();
    const queue = {
      name: 'scratch',
      getWorkersCount: async () => 0,
      getJobs: async () => [{ id: '1', timestamp: 1, moveToWait }],
    };
    const state = await stalled(
      requeueOrphanedActiveJobs(
        queue as never,
        () => true,
        (key) => client.getRedis().incr(key),
      ),
      'INCR',
    );
    expect(state.value).toBe(0);
    expect(moveToWait).not.toHaveBeenCalled();
  });

  it('keeps a RAG writer waiting through a typed command failure, then acquires', async () => {
    const ctx = { emitProgress: vi.fn(async () => undefined) } as unknown as StepContext;
    const waiting = acquireRepoRagSyncLock(ctx, 'repo');
    const state = track(waiting);
    await fake!.nextCommand('SET');
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(state.settled).toBe(false);
    expect(ctx.emitProgress).toHaveBeenCalledWith(
      'Waiting for Redis to recover before acquiring the RAG sync lock...',
    );
    await recover();
    // Stop at the next SET, before advancing its command deadline ahead of socket I/O.
    await vi.advanceTimersByTimeAsync(5_000 - 50);
    await waiting;
    expect(state.error).toBeUndefined();
    expect(state.value).toBeDefined();
    await state.value?.release();
  });
});
