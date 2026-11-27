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

  it('settles the reservation check and pump before handing a cold boot its release', async () => {
    const reservation = vi.spyOn(getRedis(), 'hexists');
    let release: (() => void) | undefined;
    void acquireRuntimeSlot('task', 'app').then((value) => {
      release = value;
    });
    await fake.nextCommand('HEXISTS');
    let checked = false;
    void reservation.mock.results[0]!.value.then(
      () => {
        checked = true;
      },
      () => {
        checked = true;
      },
    );
    const occupancy = fake.nextCommand('HGETALL');
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(checked).toBe(true);
    await occupancy;
    // The browser and reservation reads are independent and both get their own deadline.
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(release).toBeTypeOf('function');
    release!();
  });
});
