import { expect, it, vi } from 'vitest';
import { waitForPgLock } from './fixtures/wait-for-pg-lock.js';

it('yields between probes so a delayed lock waiter can become visible', async () => {
  let now = 0;
  const wait = vi.fn(async (ms: number) => {
    now += ms;
  });
  const probe = vi.fn(async () => now >= 20);
  expect(await waitForPgLock(probe, { timeoutMs: 30, intervalMs: 10, now: () => now, wait })).toBe(
    true,
  );
  expect(wait.mock.calls).toEqual([[10], [10]]);
  expect(probe).toHaveBeenCalledTimes(3);
});

it('stops at a bounded deadline under fake timers', async () => {
  vi.useFakeTimers();
  try {
    const probe = vi.fn(async () => false);
    const polling = waitForPgLock(probe, {
      timeoutMs: 25,
      intervalMs: 10,
      now: Date.now,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(await polling).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
