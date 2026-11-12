import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUNDLE_JOB_NAMES } from '@haive/shared';
import {
  BUNDLE_ORPHAN_INTERVAL_MS,
  BUNDLE_ORPHAN_MAX_AGE_MS,
  BUNDLE_ORPHAN_MAX_BUNDLES,
  BUNDLE_ORPHAN_MAX_DIRECTORY_ENTRIES,
  BUNDLE_ORPHAN_MAX_QUEUE_JOBS,
  BUNDLE_ORPHAN_QUEUE_TIMEOUT_MS,
  readLiveBundleJobs,
} from '../src/repo/bundle-orphan-sweep.js';

const bundleId = '00000000-0000-4000-8000-0000000000b1';
function source() {
  return {
    getRanges: vi.fn(async () => ['job']),
    getJob: vi.fn(async (_id: string): Promise<unknown> => ({
      name: BUNDLE_JOB_NAMES.INGEST_ZIP,
      data: { bundleId },
    })),
  };
}
function read(queue: ReturnType<typeof source>, options = {}) {
  return readLiveBundleJobs(queue as unknown as Parameters<typeof readLiveBundleJobs>[0], options);
}
afterEach(() => {
  vi.useRealTimers();
});

describe('bundle orphan liveness snapshot', () => {
  it('pins the production retention, cadence and work bounds', () => {
    expect([
      BUNDLE_ORPHAN_MAX_AGE_MS,
      BUNDLE_ORPHAN_INTERVAL_MS,
      BUNDLE_ORPHAN_MAX_BUNDLES,
      BUNDLE_ORPHAN_MAX_DIRECTORY_ENTRIES,
      BUNDLE_ORPHAN_MAX_QUEUE_JOBS,
      BUNDLE_ORPHAN_QUEUE_TIMEOUT_MS,
    ]).toEqual([86_400_000, 3_600_000, 100, 1000, 1000, 5000]);
  });

  it('reads waiting, active, delayed, prioritized and waiting-children jobs', async () => {
    const queue = source();
    expect(await read(queue, { maxJobs: 4 })).toEqual([{ bundleId }]);
    expect(queue.getRanges).toHaveBeenCalledWith(
      ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'],
      0,
      3,
    );
  });

  it('holds cleanup when the atomic ID snapshot hits its small cap', async () => {
    const queue = source();
    queue.getRanges.mockResolvedValue(['first', 'second']);
    expect(await read(queue, { maxJobs: 2 })).toBeNull();
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('does not mistake a vanished job hash for a complete empty queue', async () => {
    const queue = source();
    queue.getJob.mockResolvedValue(undefined);
    expect(await read(queue)).toBeNull();
  });

  it('holds cleanup when Redis rejects the read', async () => {
    const queue = source();
    queue.getRanges.mockRejectedValue(new Error('redis unavailable'));
    expect(await read(queue)).toBeNull();
  });

  it.each(['snapshot', 'hydration'])('bounds the %s with one deadline', async (phase) => {
    vi.useFakeTimers();
    const queue = source();
    if (phase === 'snapshot')
      queue.getRanges.mockImplementation(() => new Promise(() => undefined));
    else queue.getJob.mockImplementation(() => new Promise(() => undefined));
    const result = read(queue, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds cleanup when a non-tick job has unreadable ownership', async () => {
    const queue = source();
    queue.getJob.mockResolvedValue({ name: BUNDLE_JOB_NAMES.INGEST_ZIP, data: {} });
    expect(await read(queue)).toBeNull();
  });

  it('ignores the periodic sync tick which owns no archive or stage', async () => {
    const queue = source();
    queue.getJob.mockResolvedValue({ name: BUNDLE_JOB_NAMES.GIT_SYNC_TICK, data: {} });
    expect(await read(queue)).toEqual([]);
  });
});
