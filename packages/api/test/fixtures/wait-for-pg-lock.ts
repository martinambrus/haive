import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/** Poll the real server's lock view, with injectable timing for the unit controls. */
export async function waitForPgLock(
  probe: () => Promise<boolean>,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  // Native monotonic time and native timers do not stall if a surrounding test
  // freezes the global clock. Unit controls inject both to avoid real waiting.
  const now = opts.now ?? (() => performance.now());
  const wait = opts.wait ?? delay;
  const deadline = now() + (opts.timeoutMs ?? 2_000);
  const interval = opts.intervalMs ?? 10;
  while (now() < deadline) {
    if (await probe()) return true;
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(interval, remaining));
  }
  return false;
}
