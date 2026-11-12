import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

export const CLI_LOGIN_LEASE_TTL_MS = 60_000;
export const CLI_LOGIN_LEASE_HEARTBEAT_MS = 20_000;
export const CLI_LOGIN_LABEL = 'haive.cli-login';
export const CLI_LOGIN_LEASE_LABEL = 'haive.cli-login.lease';
export const cliLoginLeaseKey = (id: string): string => `cli-login-lease:${id}`;

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1]) end return 0`;

export interface CliLoginLease {
  id: string;
  assertHeld(): void;
  stop(): Promise<void>;
}

/** Created before queueing Docker creation. Renewals never recreate an expired lease, so a
 * reaper that observed absence cannot race a returning owner into deleting a live login. */
export async function startCliLoginLease(
  redis: Pick<Redis, 'set' | 'eval'>,
  onLost: () => void,
  options: { ttlMs?: number; heartbeatMs?: number } = {},
): Promise<CliLoginLease> {
  const ttlMs = options.ttlMs ?? CLI_LOGIN_LEASE_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? CLI_LOGIN_LEASE_HEARTBEAT_MS;
  if (heartbeatMs <= 0 || heartbeatMs >= ttlMs) throw new Error('Invalid login lease timing');
  const id = randomUUID();
  const token = randomUUID();
  const key = cliLoginLeaseKey(id);
  const initialUntil = Date.now() + ttlMs;
  if ((await redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') {
    throw new Error('Unable to acquire login lease');
  }
  let active = true;
  let until = initialUntil;
  let renewing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const lose = () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    onLost();
  };
  const timer = setInterval(() => {
    if (!active || renewing) return;
    const nextUntil = Date.now() + ttlMs;
    renewing = (async () => {
      try {
        if (Date.now() >= until || (await redis.eval(RENEW, 1, key, token, ttlMs)) !== 1) {
          lose();
          return;
        }
        until = nextUntil;
      } catch {
        // A failed call is unknown, not lost: the local deadline was set before the last
        // successful renewal, so it passes no later than Redis expires the key.
        if (Date.now() >= until) lose();
      }
    })().finally(() => {
      renewing = undefined;
    });
  }, heartbeatMs);
  timer.unref?.();
  return {
    id,
    assertHeld() {
      if (!active || Date.now() >= until) throw new Error('Login lease lost');
    },
    stop() {
      active = false;
      clearInterval(timer);
      // Drain a renewal before deleting, including one already awaiting Redis at cleanup.
      return (stopping ??= (async () => {
        await renewing;
        await redis.eval(RELEASE, 1, key, token);
      })());
    },
  };
}
