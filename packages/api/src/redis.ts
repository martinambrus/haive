import { ReplyError, type Redis, type RedisOptions } from 'ioredis';
import { createRedisConnection, createBullRedisConnection, logger } from '@haive/shared';
import { RedisUnavailableError } from './lib/redis-unavailable.js';

const REDIS_COMMAND_TIMEOUT_MS = 2000;
const ERROR_LOG_INTERVAL_MS = 10_000;

const BOUNDED_OPTIONS: RedisOptions = {
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
  retryStrategy: (times: number) => Math.min(times * 50, 500),
};

let redisInstance: Redis | null = null;
let patientRedisInstance: Redis | null = null;
let bullRedisInstance: Redis | null = null;
let lastErrorLogAt = 0;

function warnThrottled(err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt = now;
  logger.warn({ err }, 'api Redis connection error');
}

type Command = { reject: (err: Error) => void };

function bound(redis: Redis): Redis {
  const wrapped = new WeakSet<object>();
  const sendCommand = redis.sendCommand.bind(redis) as (
    command: Command,
    stream?: unknown,
  ) => unknown;
  (redis as unknown as { sendCommand: typeof sendCommand }).sendCommand = (command, stream) => {
    if (!wrapped.has(command)) {
      wrapped.add(command);
      const reject = command.reject;
      command.reject = (err: Error) => {
        if (err instanceof ReplyError || err instanceof RedisUnavailableError) {
          reject.call(command, err);
          return;
        }
        warnThrottled(err);
        reject.call(command, new RedisUnavailableError(err));
      };
    }
    return sendCommand(command, stream);
  };
  redis.on('error', warnThrottled);
  redis.duplicate = () => {
    throw new Error(
      'getRedis() has a command deadline: duplicate getPatientRedis() for blocking reads and subscribers',
    );
  };
  return redis;
}

export function initRedis(url: string): {
  redis: Redis;
  bullRedis: Redis;
  patientRedis: Redis;
} {
  if (!redisInstance) {
    redisInstance = bound(createRedisConnection(url, BOUNDED_OPTIONS));
  }
  if (!patientRedisInstance) {
    patientRedisInstance = createRedisConnection(url);
  }
  if (!bullRedisInstance) {
    bullRedisInstance = createBullRedisConnection(url);
  }
  return { redis: redisInstance, bullRedis: bullRedisInstance, patientRedis: patientRedisInstance };
}

/** For request paths. Rejects `RedisUnavailableError` (503) when Redis is down or silent past the
 *  command deadline; a command that timed out may still have landed. */
export function getRedis(): Redis {
  if (!redisInstance) {
    throw new Error('Redis not initialized. Call initRedis() first.');
  }
  return redisInstance;
}

/** Socket-lifetime work only (blocking reads, subscribers, refcount and boot bookkeeping): has no
 *  command deadline and waits out an outage. */
export function getPatientRedis(): Redis {
  if (!patientRedisInstance) {
    throw new Error('Patient Redis not initialized. Call initRedis() first.');
  }
  return patientRedisInstance;
}

export function getBullRedis(): Redis {
  if (!bullRedisInstance) {
    throw new Error('Bull Redis not initialized. Call initRedis() first.');
  }
  return bullRedisInstance;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled(
    [redisInstance, patientRedisInstance, bullRedisInstance].map(async (client) => {
      if (!client) return;
      if (client.status === 'ready') {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      } else {
        client.disconnect();
      }
    }),
  );
  redisInstance = null;
  patientRedisInstance = null;
  bullRedisInstance = null;
}
