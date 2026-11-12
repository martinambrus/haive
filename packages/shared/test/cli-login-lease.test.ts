import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  CLI_LOGIN_LEASE_TTL_MS,
  CLI_LOGIN_LEASE_HEARTBEAT_MS,
  cliLoginLeaseKey,
  startCliLoginLease,
} from '../src/cli-login-lease.js';

const entries = new Map<string, { value: string; until: number }>();
function read(key: string) {
  const entry = entries.get(key);
  if (entry && entry.until > Date.now()) return entry.value;
  entries.delete(key);
  return null;
}
const redis = {
  set: vi.fn(async (key: string, value: string, _px: string, ttl: number) => {
    if (read(key)) return null;
    entries.set(key, { value, until: Date.now() + ttl });
    return 'OK';
  }),
  eval: vi.fn(async (script: string, _count: number, key: string, token: string, ttl?: number) => {
    if (read(key) !== token) return 0;
    if (script.includes('pexpire')) entries.get(key)!.until = Date.now() + ttl!;
    else entries.delete(key);
    return 1;
  }),
};
beforeEach(() => {
  vi.useFakeTimers();
  entries.clear();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
const options = { ttlMs: 60, heartbeatMs: 20 };

it('pins the short production lease and heartbeat', () => {
  expect([CLI_LOGIN_LEASE_TTL_MS, CLI_LOGIN_LEASE_HEARTBEAT_MS]).toEqual([60_000, 20_000]);
});
it('keeps renewing a live owner beyond the original TTL', async () => {
  const lost = vi.fn();
  const lease = await startCliLoginLease(redis as never, lost, options);
  await vi.advanceTimersByTimeAsync(180);
  expect(read(cliLoginLeaseKey(lease.id))).not.toBeNull();
  expect(lost).not.toHaveBeenCalled();
  await lease.stop();
  expect(read(cliLoginLeaseKey(lease.id))).toBeNull();
});
it('a dead owner expires without renewals', async () => {
  const lease = await startCliLoginLease(redis as never, vi.fn(), options);
  const diedAt = Date.now();
  vi.clearAllTimers(); // process death: no stop and no further renewal
  vi.setSystemTime(diedAt + 59);
  expect(read(cliLoginLeaseKey(lease.id))).not.toBeNull();
  vi.setSystemTime(diedAt + 61);
  expect(read(cliLoginLeaseKey(lease.id))).toBeNull();
});
it('a stale owner neither renews nor deletes a different token', async () => {
  const lost = vi.fn();
  const lease = await startCliLoginLease(redis as never, lost, options);
  const key = cliLoginLeaseKey(lease.id);
  entries.set(key, { value: 'new-owner', until: Date.now() + 1000 });
  await vi.advanceTimersByTimeAsync(20);
  expect(lost).toHaveBeenCalledOnce();
  await lease.stop();
  expect(read(key)).toBe('new-owner');
});
it('an expired owner cannot resurrect its lease', async () => {
  const lost = vi.fn();
  const lease = await startCliLoginLease(redis as never, lost, options);
  entries.clear();
  await vi.advanceTimersByTimeAsync(20);
  expect(lost).toHaveBeenCalledOnce();
  expect(read(cliLoginLeaseKey(lease.id))).toBeNull();
  await lease.stop();
});
it('does not renew after owner cleanup', async () => {
  const lease = await startCliLoginLease(redis as never, vi.fn(), options);
  await lease.stop();
  const calls = redis.eval.mock.calls.length;
  await vi.advanceTimersByTimeAsync(180);
  expect(redis.eval).toHaveBeenCalledTimes(calls);
});

it('drains an outstanding renewal before compare-deleting the owner lease', async () => {
  const lease = await startCliLoginLease(redis as never, vi.fn(), options);
  let finish!: (value: 0 | 1) => void;
  redis.eval.mockImplementationOnce(
    () =>
      new Promise<0 | 1>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(20);
  let stopped = false;
  const stopping = lease.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(redis.eval).toHaveBeenCalledOnce();
  finish(1);
  await stopping;
  expect(read(cliLoginLeaseKey(lease.id))).toBeNull();
  expect(redis.eval).toHaveBeenCalledTimes(2);
});
