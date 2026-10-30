import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { CLI_POLLABLE_JOB_OPTS, type RefreshCliVersionsJobResult } from '@haive/shared/constants';
import {
  jobPhaseForState,
  POLL_TIMEOUT_MS,
  runCatalogVersionRefresh,
  runPricingRefresh,
} from './cli-jobs';
import type { CliPackageVersionsEntry } from './api-client';

describe('jobPhaseForState', () => {
  it('calls only an active job running', () => {
    expect(jobPhaseForState('active')).toBe('running');
  });

  it('collapses every way of waiting into one queued phase', () => {
    // The bug this whole polling path replaced: a job sitting behind multi-minute agent runs
    // was indistinguishable from a broken provider. Which flavour of waiting it is
    // ('prioritized' vs 'waiting' is a BullMQ storage detail, not user-facing) must not leak
    // into the label — all of them mean the same thing to the person who clicked the button.
    for (const state of ['waiting', 'prioritized', 'delayed', 'waiting-children']) {
      expect(jobPhaseForState(state)).toBe('queued');
    }
  });

  it('treats an unreported state as queued', () => {
    // A pending response with no state is still pending; guessing "running" would claim work
    // that may not have started.
    expect(jobPhaseForState(undefined)).toBe('queued');
  });
});

describe('POLL_TIMEOUT_MS', () => {
  it('stays under the server-side job retention', () => {
    // Polling past retention would report "expired" for work that succeeded.
    for (const retention of [
      CLI_POLLABLE_JOB_OPTS.removeOnComplete,
      CLI_POLLABLE_JOB_OPTS.removeOnFail,
    ]) {
      expect(POLL_TIMEOUT_MS).toBeLessThan(retention.age * 1000);
    }
  });
});

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./api-client', () => ({ api: h }));

beforeEach(() => {
  vi.useFakeTimers();
  h.post.mockReset().mockResolvedValue({ jobId: '42' });
  h.get.mockReset().mockResolvedValue({ status: 'pending', state: 'waiting' });
});
afterEach(() => vi.useRealTimers());

describe('queued job polling', () => {
  it.each(['waiting', 'active'])('names the last observed phase at timeout (%s)', async (state) => {
    h.get.mockResolvedValue({ status: 'pending', state });
    const result = runPricingRefresh().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    expect(((await result) as Error).message).toContain(
      state === 'active' ? 'Still running.' : 'Still queued behind running CLI jobs.',
    );
  });

  it('retries transient poll failures, resetting the bound after a successful poll', async () => {
    h.get
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ status: 'pending', state: 'active' })
      .mockRejectedValueOnce(new TypeError('network down again'))
      .mockResolvedValueOnce({ status: 'done' });
    const result = runPricingRefresh().then(
      () => 'done',
      () => 'failed',
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toBe('done');
    expect(h.get).toHaveBeenCalledTimes(5);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('gives up after three consecutive failed poll requests', async () => {
    h.get.mockRejectedValue(new TypeError('offline'));
    const result = runPricingRefresh().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ message: 'offline' });
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry an expired job or a refused request', async () => {
    for (const failure of [
      Object.assign(new Error('expired'), { code: 'job_expired', status: 404 }),
      Object.assign(new Error('forbidden'), { status: 403 }),
    ]) {
      h.get.mockClear().mockRejectedValue(failure);
      await expect(runPricingRefresh()).rejects.toBe(failure);
      expect(h.get).toHaveBeenCalledTimes(1);
    }
  });

  it('aborts before enqueueing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runPricingRefresh(undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.post).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('aborts the wait between polls and clears its timer', async () => {
    const controller = new AbortController();
    const result = runPricingRefresh(undefined, controller.signal).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes cancellation to an in-flight GET without retrying it', async () => {
    const controller = new AbortController();
    h.get.mockImplementation(
      (_path: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const result = runPricingRefresh(undefined, controller.signal).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.get).toHaveBeenCalledWith('/cli-pricing/refresh/42', controller.signal);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('refresh results', () => {
  const entry: CliPackageVersionsEntry = {
    name: 'claude-code',
    versions: ['2.0.1', '2.0.0'],
    latestVersion: '2.0.1',
    fetchedAt: null,
    fetchError: null,
  };
  const refreshed = [{ name: 'claude-code', count: 2, latest: '2.0.1' }];
  const results: [string, RefreshCliVersionsJobResult][] = [
    [
      'a failed source',
      { ok: false, refreshed, errors: [{ name: 'fx', error: 'fx feed HTTP 503' }] },
    ],
    ['every source ok', { ok: true, refreshed, errors: [] }],
  ];

  it.each(results)('hands the pricing refresh result to the caller: %s', async (_label, result) => {
    h.get.mockResolvedValue({ status: 'done', result });
    await expect(runPricingRefresh()).resolves.toEqual(result);
    expect(h.get).toHaveBeenCalledWith('/cli-pricing/refresh/42');
  });

  it.each(results)(
    'hands the version refresh entry and result to the caller: %s',
    async (_label, result) => {
      h.get.mockResolvedValue({ status: 'done', entry, result });
      await expect(runCatalogVersionRefresh('claude-code')).resolves.toEqual({ entry, result });
      expect(h.post).toHaveBeenCalledWith('/cli-providers/catalog/claude-code/refresh-versions');
      expect(h.get).toHaveBeenCalledWith('/cli-providers/catalog/claude-code/refresh-versions/42');
    },
  );
});
