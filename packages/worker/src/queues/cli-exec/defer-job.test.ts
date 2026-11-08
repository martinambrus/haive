import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from './_shared.js';
import { DEFER_RETRY_WINDOW_MS, deferJob } from './defer-job.js';

type DeferTarget = Parameters<typeof deferJob>[0];

/** What Redis answers while it replays its dataset after a restart: at once, and a server reply
 *  rather than a connection error, so BullMQ's own retry never sees it. */
const refusal = (): Error =>
  Object.assign(new Error('LOADING Redis is loading the dataset in memory'), {
    name: 'ReplyError',
  });

const jobOf = (moveToDelayed: ReturnType<typeof vi.fn>): DeferTarget =>
  ({ id: '7', moveToDelayed }) as unknown as DeferTarget;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('deferJob', () => {
  it('defers once, for the requested delay, when the store takes it', async () => {
    const moveToDelayed = vi.fn(async () => undefined);

    await deferJob(jobOf(moveToDelayed), 4_000, 'tok');

    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed).toHaveBeenCalledWith(Date.now() + 4_000, 'tok');
  });

  it('retries a refusal and defers once the store answers', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const moveToDelayed = vi
      .fn()
      .mockRejectedValueOnce(refusal())
      .mockRejectedValueOnce(refusal())
      .mockResolvedValue(undefined);

    const done = deferJob(jobOf(moveToDelayed), 10_000, 'tok');
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(moveToDelayed).toHaveBeenCalledTimes(3);
    // The delay counts from each attempt, not from the first refusal.
    expect(moveToDelayed.mock.calls[2]![0] - moveToDelayed.mock.calls[0]![0]).toBe(2_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying until the window is spent', async () => {
    const attempts = DEFER_RETRY_WINDOW_MS / 1_000 - 1;
    const moveToDelayed = vi.fn().mockResolvedValue(undefined);
    for (let i = 0; i < attempts; i++) moveToDelayed.mockRejectedValueOnce(refusal());
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    const done = deferJob(jobOf(moveToDelayed), 10_000, 'tok');
    await vi.advanceTimersByTimeAsync(DEFER_RETRY_WINDOW_MS);
    await done;

    expect(moveToDelayed).toHaveBeenCalledTimes(attempts + 1);
  });

  it('throws the last refusal once the window is spent', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const last = refusal();
    const moveToDelayed = vi.fn().mockRejectedValueOnce(refusal()).mockRejectedValue(last);

    const settled = deferJob(jobOf(moveToDelayed), 10_000, 'tok').then(
      () => 'deferred',
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(DEFER_RETRY_WINDOW_MS + 5_000);

    expect(await settled).toBe(last);
    expect(moveToDelayed).toHaveBeenCalledTimes(DEFER_RETRY_WINDOW_MS / 1_000 + 1);
  });
});
