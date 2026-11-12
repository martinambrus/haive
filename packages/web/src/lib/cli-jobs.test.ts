import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  CLI_POLLABLE_JOB_OPTS,
  CLI_SIGN_OUT_AUTH_WAIT_MS,
  type RefreshCliVersionsJobResult,
} from '@haive/shared/constants';
import {
  jobPhaseForState,
  POLL_TIMEOUT_MS,
  SIGN_OUT_POLL_TIMEOUT_MS,
  runCatalogVersionRefresh,
  runPricingRefresh,
  runCliSignOut,
  runCliProbe,
  signOutSummary,
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

describe('poll budgets', () => {
  it('keeps the default poll timeout under completed and failed job retention', () => {
    // Sign-out is exempt: it polls continuously, and retention counts from completion.
    for (const retention of [
      CLI_POLLABLE_JOB_OPTS.removeOnComplete,
      CLI_POLLABLE_JOB_OPTS.removeOnFail,
    ]) {
      expect(POLL_TIMEOUT_MS).toBeLessThan(retention.age * 1000);
    }
  });

  it('keeps the default at ten minutes and allows the worker auth wait plus margin for sign-out', () => {
    expect(POLL_TIMEOUT_MS).toBe(10 * 60_000);
    expect(SIGN_OUT_POLL_TIMEOUT_MS).toBeGreaterThan(CLI_SIGN_OUT_AUTH_WAIT_MS + 15_000);
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
    expect(((await result) as Error).message).toContain('The latest refresh result is saved');
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

describe('superseded sign-out', () => {
  it('keeps the flag through polling and tells the user their newer login was kept', async () => {
    const result = { ok: true, superseded: true, removed: [], failed: [] };
    h.get.mockResolvedValue({ status: 'done', result });
    expect(await runCliSignOut('provider')).toEqual(result);
    expect(signOutSummary(result)).toBe(
      'Sign-out skipped because you signed in again. Your current login was kept.',
    );
    expect(signOutSummary({ ok: true, removed: [], failed: [] })).toBe('Already signed out.');
    expect(signOutSummary({ ok: true, removed: ['volume'], failed: [] })).toBe('Removed: volume');
  });
});

it('shows the worker auth-contention failure text for sign-out', async () => {
  const error = 'A CLI sign-in or credential update kept this account busy. Nothing was removed.';
  h.get.mockResolvedValue({ status: 'failed', error });
  await expect(runCliSignOut('provider')).rejects.toThrow(error);
});

it('continues sign-out polling at eleven minutes and surfaces a later worker failure', async () => {
  h.get.mockResolvedValue({ status: 'pending', state: 'delayed' });
  let settled = false;
  const result = runCliSignOut('provider')
    .catch((error: Error) => error)
    .finally(() => {
      settled = true;
    });
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  expect(settled).toBe(false);
  expect(h.get).toHaveBeenCalledTimes(331);
  const error = 'A CLI sign-in or credential update kept this account busy. Nothing was removed.';
  await vi.advanceTimersByTimeAsync(19 * 60_000);
  expect(settled).toBe(false);
  h.get.mockResolvedValue({ status: 'failed', error });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await result).toMatchObject({ message: error });
});

it('a probe still times out at ten minutes', async () => {
  const result = runCliProbe('provider').catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(await result).toMatchObject({
    message: expect.stringContaining('Still queued behind running CLI jobs.'),
  });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ['delayed', 'Sign-out is still queued.'],
  ['waiting', 'Still queued behind running CLI jobs.'],
  ['prioritized', 'Still queued behind running CLI jobs.'],
  ['active', 'Still running.'],
  [undefined, 'Still queued behind running CLI jobs.'],
] as const)(
  'a sign-out poll timeout names the last observed state (%s)',
  async (state, message) => {
    h.get
      .mockResolvedValueOnce({
        status: 'pending',
        state: state === 'delayed' ? 'active' : 'delayed',
      })
      .mockResolvedValue({ status: 'pending', state });
    const onPhase = vi.fn();
    const result = runCliSignOut('provider', onPhase).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_POLL_TIMEOUT_MS);
    expect(await result).toMatchObject({ message: expect.stringContaining(message) });
    expect(onPhase).toHaveBeenLastCalledWith(state === 'active' ? 'running' : 'queued');
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  [undefined, 'Sign-out is still queued.'],
  ['auth_busy', 'Still waiting for this account to become available.'],
  ['settings_changed', 'CLI authentication settings changed.'],
])('uses the structural defer reason at sign-out timeout (%s)', async (waitReason, message) => {
  h.get.mockResolvedValue({ status: 'pending', state: 'delayed', waitReason });
  const result = runCliSignOut('provider').catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(SIGN_OUT_POLL_TIMEOUT_MS);
  expect(await result).toMatchObject({ message: expect.stringContaining(message) });
});
it.each([16, 40])(
  'shows an expired observed sign-out after a %s minute stall as an unknown outcome',
  async (minutes) => {
    h.get.mockResolvedValueOnce({ status: 'pending', state: 'active' });
    const result = runCliSignOut('provider');
    await vi.advanceTimersByTimeAsync(0);
    h.get.mockRejectedValue(
      Object.assign(new Error('expired'), { code: 'job_expired', status: 404 }),
    );
    vi.setSystemTime(Date.now() + minutes * 60_000);
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await result;
    expect(outcome).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(signOutSummary(outcome)).toBe(
      'Sign-out result is no longer available. Check the account status before trying again.',
    );
    expect(h.post).toHaveBeenCalledTimes(1);
  },
);
it('keeps an immediately missing unobserved sign-out as an error', async () => {
  h.get.mockRejectedValue(
    Object.assign(new Error('expired'), { code: 'job_expired', status: 404 }),
  );
  await expect(runCliSignOut('provider')).rejects.toThrow('expired');
});
