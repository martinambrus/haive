import { once } from 'node:events';
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

  it('refuses a cold boot when its reservation check is unreadable', async () => {
    let settled = false;
    let failure: unknown;
    void acquireRuntimeSlot('task', 'app').then(
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
    expect(settled).toBe(true);
    expect(failure).toMatchObject({ code: 'redis_unavailable' });
    expect(fake.commands.some((c) => c[0]!.toUpperCase() === 'HGETALL')).toBe(false);
  });
});

it('refuses an unknown reservation before a readable occupancy can queue on its own slot', async () => {
  fake.mute = false;
  const error = Object.assign(new Error('lost HEXISTS reply'), { code: 'redis_unavailable' });
  vi.spyOn(getRedis(), 'hexists').mockRejectedValueOnce(error);
  const occupancy = vi.spyOn(getRedis(), 'hgetall');
  await expect(acquireRuntimeSlot('reserved-task', 'app')).rejects.toBe(error);
  expect(occupancy).not.toHaveBeenCalled();
});
