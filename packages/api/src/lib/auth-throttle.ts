import { randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { logger } from '@haive/shared';
import { getRedis } from '../redis.js';
import { isBlockedAddress } from './egress-guard.js';

const log = logger.child({ module: 'auth-throttle' });

export const AUTH_THROTTLE_WINDOW_MS = 60_000;
export const AUTH_ACCOUNT_LIMIT = 10;
export const AUTH_IP_LIMIT = 30;

const REDIS_WAIT_MS = 400;
const KEY_PREFIX = 'haive:auth-throttle:';

export const AUTH_THROTTLE_SCRIPT = `
local rejected = false
local wait = 0
local rejectedKey = ""
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[2])
  local limit = tonumber(ARGV[4 + i])
  local count = redis.call('ZCARD', KEYS[i])
  if count >= limit then
    rejected = true
    local idx = count - limit
    local oldest = redis.call('ZRANGE', KEYS[i], idx, idx, 'WITHSCORES')
    local free = tonumber(oldest[2]) + tonumber(ARGV[3]) - tonumber(ARGV[1])
    if rejectedKey == "" or free > wait then
      wait = free
      rejectedKey = KEYS[i]
    end
  end
end
if rejected then return {0, wait, rejectedKey} end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], ARGV[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[i], ARGV[3])
end
return {1, 0}
`;

type Scope = 'login' | 'register';

export interface AuthAttempt {
  refund(): Promise<void>;
}

const NOOP_ATTEMPT: AuthAttempt = { refund: async () => undefined };

export function normalizeAddress(raw: string): string {
  const unzoned = raw.split('%')[0] ?? '';
  if (isIP(unzoned) !== 6) return unzoned;
  const canonical = new URL(`http://[${unzoned}]`).hostname;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);
  if (mapped === null) return unzoned;
  const high = parseInt(mapped[1] as string, 16);
  const low = parseInt(mapped[2] as string, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function addressBucket(address: string): string {
  if (isIP(address) !== 6) return address;
  const [head = '', tail] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
          ...tailGroups,
        ];
  return groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':');
}

let trustedRaw: string | undefined;
let trustedList = new BlockList();

export function parseTrustedProxies(raw: string): BlockList {
  const list = new BlockList();
  for (const entry of raw.split(',')) {
    const item = entry.trim();
    if (item === '') continue;
    const [addr = '', prefixText] = item.split('/');
    const family = isIP(addr);
    const prefix = prefixText === undefined ? undefined : Number(prefixText);
    const maxPrefix = family === 4 ? 32 : 128;
    const valid =
      family !== 0 &&
      (prefix === undefined || (Number.isInteger(prefix) && prefix >= 0 && prefix <= maxPrefix));
    if (!valid) {
      log.warn({ entry: item }, 'HAIVE_TRUSTED_PROXIES entry ignored: not an IP or CIDR');
      continue;
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) list.addAddress(addr, type);
    else list.addSubnet(addr, prefix, type);
  }
  return list;
}

function trustedProxies(): BlockList {
  const raw = process.env.HAIVE_TRUSTED_PROXIES ?? '';
  if (raw !== trustedRaw) {
    trustedList = parseTrustedProxies(raw);
    trustedRaw = raw;
  }
  return trustedList;
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function resolveClientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
  list: BlockList,
): string | undefined {
  if (peer === undefined || peer === '') return undefined;
  const peerAddress = normalizeAddress(peer);
  if (isIP(peerAddress) === 0) return undefined;
  if (!isTrusted(list, peerAddress) || forwardedFor === undefined) return peerAddress;
  const hops = forwardedFor.split(',').map((hop) => normalizeAddress(hop.trim()));
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (isIP(hop) === 0) return peerAddress;
    if (!isTrusted(list, hop)) return hop;
  }
  return peerAddress;
}

function countedAddress(c: Context): string | undefined {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
  const address = resolveClientAddress(peer, c.req.header('x-forwarded-for'), trustedProxies());
  if (address === undefined) return undefined;
  const suppliedByProxy = address !== normalizeAddress(peer as string);
  return !suppliedByProxy && isBlockedAddress(address) ? undefined : address;
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('redis did not answer in time')), REDIS_WAIT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class AuthThrottleError extends HTTPException {
  constructor(
    res: Response,
    readonly auditAllowed: boolean,
    readonly limiter: 'account' | 'address',
  ) {
    super(429, { res });
  }
}

function refused(
  scope: Scope,
  waitMs: number,
  auditAllowed: boolean,
  limiter: 'account' | 'address',
): AuthThrottleError {
  const seconds = Math.min(Math.max(1, Math.ceil(waitMs / 1000)), AUTH_THROTTLE_WINDOW_MS / 1000);
  const what = scope === 'login' ? 'sign-in' : 'registration';
  const res = Response.json(
    {
      error: `Too many ${what} attempts. Try again in ${seconds} seconds.`,
      code: 'rate_limited',
      retryAfterSeconds: seconds,
    },
    { status: 429, headers: { 'Retry-After': String(seconds) } },
  );
  return new AuthThrottleError(res, auditAllowed, limiter);
}

export async function reserveAuthAttempt(
  c: Context,
  scope: Scope,
  account: string,
): Promise<AuthAttempt> {
  let keys: string[];
  let member: string;
  let redis: ReturnType<typeof getRedis>;
  let outcome: unknown;
  let late: (() => void) | undefined;
  try {
    redis = getRedis();
    if (redis.status !== 'ready') throw new Error(`redis is ${redis.status}`);
    const address = countedAddress(c);
    keys = [`${KEY_PREFIX}${scope}:acct:${account}`];
    const limits = [AUTH_ACCOUNT_LIMIT];
    if (address !== undefined) {
      keys.push(`${KEY_PREFIX}${scope}:ip:${addressBucket(address)}`);
      limits.push(AUTH_IP_LIMIT);
    }
    member = randomUUID();
    const now = Date.now();
    const reservation = redis.eval(
      AUTH_THROTTLE_SCRIPT,
      keys.length,
      ...keys,
      now,
      now - AUTH_THROTTLE_WINDOW_MS,
      AUTH_THROTTLE_WINDOW_MS,
      member,
      ...limits,
    );
    const held = { keys, member };
    late = () =>
      void reservation.then(
        () =>
          Promise.all(held.keys.map((key) => redis.zrem(key, held.member))).catch(() => undefined),
        () => undefined,
      );
    outcome = await bounded(reservation);
    if (!Array.isArray(outcome) || (outcome.length !== 2 && outcome.length !== 3)) {
      throw new Error('unexpected reply from the throttle script');
    }
  } catch (err) {
    log.warn({ err }, 'auth throttle unavailable, admitting the attempt');
    late?.();
    return NOOP_ATTEMPT;
  }
  const [admitted, waitMs, rejectedKey] = outcome as [number, number, string?];
  if (Number(admitted) !== 1) {
    let auditAllowed = false;
    if (scope === 'login' && rejectedKey && keys.includes(rejectedKey)) {
      try {
        auditAllowed =
          (await bounded(
            redis.set(`${rejectedKey}:audit`, '1', 'PX', AUTH_THROTTLE_WINDOW_MS, 'NX'),
          )) === 'OK';
      } catch (err) {
        log.warn({ err }, 'throttled sign-in audit gate unavailable');
      }
    }
    throw refused(
      scope,
      Number(waitMs),
      auditAllowed,
      rejectedKey === keys[0] ? 'account' : 'address',
    );
  }
  return {
    refund: async () => {
      try {
        await bounded(Promise.all(keys.map((key) => redis.zrem(key, member))));
      } catch {
        return;
      }
    },
  };
}
