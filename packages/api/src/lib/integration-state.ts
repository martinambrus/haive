import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

const OAUTH_ATTEMPT_TTL_SECONDS = 600;
const DEVICE_RECORD_MAX_TTL_SECONDS = 1800;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

// One key per (user, provider): the key is what binds an attempt to the session that started it,
// and what keeps the keyspace at users x providers under Redis' noeviction policy.
export const oauthAttemptKey = (userId: string, providerId: string) =>
  `integration-oauth:${userId}:${providerId}`;
export const deviceRecordKey = (userId: string, providerId: string) =>
  `integration-device:${userId}:${providerId}`;

// Compare and delete in one script: two requests holding one state cannot both take the attempt.
const TAKE_ATTEMPT_SCRIPT = `
if redis.call('HGET', KEYS[1], 'stateHash') ~= ARGV[1] then return false end
local fields = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return fields`;

// A poll claims the record by moving its next-poll time on, so a second poll of the same handle
// is answered 'early' instead of reaching the vendor.
const CLAIM_POLL_SCRIPT = `
if redis.call('HGET', KEYS[1], 'handleHash') ~= ARGV[1] then return false end
local interval = tonumber(redis.call('HGET', KEYS[1], 'interval'))
local nextPollAt = tonumber(redis.call('HGET', KEYS[1], 'nextPollAt'))
local now = tonumber(ARGV[2])
if now < nextPollAt then return {'early', tostring(interval)} end
redis.call('HSET', KEYS[1], 'nextPollAt', string.format('%.0f', now + interval * 1000))
local fields = redis.call('HGETALL', KEYS[1])
table.insert(fields, 1, 'claimed')
return fields`;

const SLOW_POLL_SCRIPT = `
if redis.call('HGET', KEYS[1], 'handleHash') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'interval', ARGV[2], 'nextPollAt', ARGV[3])
return 1`;

const DROP_RECORD_SCRIPT = `
if redis.call('HGET', KEYS[1], 'handleHash') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

function fieldsOf(flat: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
  return fields;
}

async function putHash(
  redis: Redis,
  key: string,
  fields: Record<string, string>,
  ttlSeconds: number,
): Promise<void> {
  const replies = await redis.multi().hset(key, fields).expire(key, ttlSeconds).exec();
  for (const [err] of replies ?? []) if (err) throw err;
}

export interface OauthAttempt {
  verifier: string;
  redirectUri: string;
  scopes: string[];
  clientId: string;
}

/** The latest attempt of a user at a provider replaces the earlier one. */
export function putOauthAttempt(
  redis: Redis,
  userId: string,
  providerId: string,
  state: string,
  attempt: OauthAttempt,
): Promise<void> {
  return putHash(
    redis,
    oauthAttemptKey(userId, providerId),
    {
      stateHash: digest(state),
      verifier: attempt.verifier,
      redirectUri: attempt.redirectUri,
      scopes: JSON.stringify(attempt.scopes),
      clientId: attempt.clientId,
    },
    OAUTH_ATTEMPT_TTL_SECONDS,
  );
}

/** The attempt this state belongs to, removed; null when there is none or the state is not its. */
export async function takeOauthAttempt(
  redis: Redis,
  userId: string,
  providerId: string,
  state: string,
): Promise<OauthAttempt | null> {
  const reply = (await redis.eval(
    TAKE_ATTEMPT_SCRIPT,
    1,
    oauthAttemptKey(userId, providerId),
    digest(state),
  )) as string[] | null;
  if (!reply) return null;
  const { verifier, redirectUri, scopes, clientId } = fieldsOf(reply);
  if (verifier === undefined || redirectUri === undefined || clientId === undefined) return null;
  return { verifier, redirectUri, scopes: JSON.parse(scopes ?? '[]') as string[], clientId };
}

export interface DeviceRecord {
  deviceCode: string;
  interval: number;
  clientId: string;
  scopes: string[];
}

export type DevicePollClaim =
  | { kind: 'unknown' }
  | { kind: 'early'; interval: number }
  | { kind: 'claimed'; record: DeviceRecord };

/** How long a device record lives: the vendor's lifetime for the code, bounded. */
export const deviceRecordTtl = (expiresInSeconds: number) =>
  Math.min(Math.max(Math.ceil(expiresInSeconds), 1), DEVICE_RECORD_MAX_TTL_SECONDS);

/** The first poll is due one interval after the start. */
export function putDeviceRecord(
  redis: Redis,
  userId: string,
  providerId: string,
  handle: string,
  record: DeviceRecord,
  ttlSeconds: number,
  nowMs: number,
): Promise<void> {
  return putHash(
    redis,
    deviceRecordKey(userId, providerId),
    {
      handleHash: digest(handle),
      deviceCode: record.deviceCode,
      interval: String(record.interval),
      nextPollAt: String(nowMs + record.interval * 1000),
      clientId: record.clientId,
      scopes: JSON.stringify(record.scopes),
    },
    ttlSeconds,
  );
}

export async function claimDevicePoll(
  redis: Redis,
  userId: string,
  providerId: string,
  handle: string,
  nowMs: number,
): Promise<DevicePollClaim> {
  const reply = (await redis.eval(
    CLAIM_POLL_SCRIPT,
    1,
    deviceRecordKey(userId, providerId),
    digest(handle),
    String(nowMs),
  )) as string[] | null;
  if (!reply) return { kind: 'unknown' };
  const [tag, ...rest] = reply;
  if (tag === 'early') return { kind: 'early', interval: Number(rest[0]) };
  const { deviceCode, interval, clientId, scopes } = fieldsOf(rest);
  if (deviceCode === undefined || interval === undefined || clientId === undefined) {
    return { kind: 'unknown' };
  }
  return {
    kind: 'claimed',
    record: {
      deviceCode,
      interval: Number(interval),
      clientId,
      scopes: JSON.parse(scopes ?? '[]'),
    },
  };
}

/** After the vendor said slow_down: the longer interval counts from now. */
export async function slowDevicePoll(
  redis: Redis,
  userId: string,
  providerId: string,
  handle: string,
  interval: number,
  nowMs: number,
): Promise<void> {
  await redis.eval(
    SLOW_POLL_SCRIPT,
    1,
    deviceRecordKey(userId, providerId),
    digest(handle),
    String(interval),
    String(nowMs + interval * 1000),
  );
}

export async function dropDeviceRecord(
  redis: Redis,
  userId: string,
  providerId: string,
  handle: string,
): Promise<void> {
  await redis.eval(DROP_RECORD_SCRIPT, 1, deviceRecordKey(userId, providerId), digest(handle));
}
