import { once } from 'node:events';
import { ReplyError } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveRuntimeCaps } from '@haive/shared';
import { closeRedis, getRedis, initRedis } from '../src/redis.js';
import { acquireRuntimeSlot, runtimeOccupancyMb } from '../src/sandbox/runtime-admission.js';
import { startFake, type Fake } from './support/redis-stall.js';

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: null, result: { stdout: string }) => void;
    cb(null, { stdout: '' });
  },
}));
vi.mock('../src/sandbox/runtime-caps.js', () => ({
  RUNTIME_WEIGHT_LABEL: 'haive.runtime.weight.mb',
  resourceLimitsEnabled: async () => true,
  resolveRuntimeCaps: async () => deriveRuntimeCaps({ totalMemMb: 16_384, cpuCount: 8 }),
  resolveRuntimeWeightMb: async () => 1024,
}));
vi.mock('../src/db.js', () => ({
  getDb: () => {
    throw new Error('no database in this control');
  },
}));

let fake: Fake;
const DEADLINE = 25;
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  fake = await startFake();
  initRedis(`redis://127.0.0.1:${fake.port}`, { commandTimeoutMs: DEADLINE }).bullRedis.on(
    'error',
    () => undefined,
  );
  if (getRedis().status !== 'ready') await once(getRedis(), 'ready');
  fake.mute = true;
});
afterEach(async () => {
  fake.mute = false;
  const closing = closeRedis();
  await vi.advanceTimersByTimeAsync(1_000);
  await closing;
  await fake.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runtime capacity keeps its documented soft-state outage policy', () => {
  it('finishes an occupancy read instead of pinning every later pump on a silent Redis', async () => {
    let busy: number | undefined;
    const reads = Promise.all([fake.nextCommand('HGETALL'), fake.nextCommand('SMEMBERS')]);
    void runtimeOccupancyMb().then((value) => {
      busy = value;
    });
    await reads;
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(busy).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(busy).toBe(0);
  });

  it('waits for an unreadable reservation before refusing at the injected bound', async () => {
    let settled = false;
    let failure: unknown;
    void acquireRuntimeSlot('task', 'app', undefined, undefined, {
      readWaitMs: 40,
      readPollMs: 5,
    }).then(
      (release) => {
        settled = true;
        release();
      },
      (error) => {
        settled = true;
        failure = error;
      },
    );
    await fake.nextCommand('HEXISTS');
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(true);
    expect(failure).toMatchObject({ code: 'redis_unavailable' });
    expect(fake.commands.some((c) => c[0]!.toUpperCase() === 'HGETALL')).toBe(false);
  });
});

it.each([
  Object.assign(new Error('lost HEXISTS reply'), { code: 'redis_unavailable' }),
  new ReplyError('LOADING arbitrary reply'),
])('rides out a reservation-read blip without queueing behind its own slot: %s', async (error) => {
  fake.mute = false;
  const read = vi
    .spyOn(getRedis(), 'hexists')
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(1);
  const occupancy = vi.spyOn(getRedis(), 'hgetall');
  let release: (() => void) | undefined;
  let failure: unknown;
  const waiting = acquireRuntimeSlot('reserved-task', 'app', undefined, undefined, {
    readWaitMs: 100,
    readPollMs: 10,
  }).then(
    (value) => {
      release = value;
    },
    (error) => {
      failure = error;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toBeUndefined();
  expect(release).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10);
  await waiting;
  expect(release).toBeTypeOf('function');
  expect(read).toHaveBeenCalledTimes(2);
  expect(occupancy).not.toHaveBeenCalled();
  release?.();
});
it('aborts a reservation-read outage without admitting or another read', async () => {
  const error = Object.assign(new Error('outage'), { code: 'redis_unavailable' });
  const read = vi.spyOn(getRedis(), 'hexists').mockRejectedValue(error);
  const ac = new AbortController();
  const waiting = acquireRuntimeSlot('task', 'app', undefined, ac.signal).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  ac.abort();
  expect(await waiting).toMatchObject({ name: 'RuntimeSlotAbortedError' });
  expect(read).toHaveBeenCalledTimes(1);
});
