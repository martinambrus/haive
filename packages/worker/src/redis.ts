import { ReplyError, type Redis, type RedisOptions } from 'ioredis';
import { createRedisConnection, createBullRedisConnection, logger } from '@haive/shared';

const QUIT_WAIT_MS = 1_000;
export const REDIS_COMMAND_TIMEOUT_MS = 2_000;
const ERROR_LOG_INTERVAL_MS = 10_000;

/** The command may have reached Redis; a timeout is an unknown write outcome. */
export class RedisUnavailableError extends Error {
  readonly code = 'redis_unavailable';
  constructor(cause: unknown) {
    super('Worker Redis temporarily unavailable', { cause });
    this.name = 'RedisUnavailableError';
  }
}

export interface RedisTuning {
  commandTimeoutMs?: number;
}

let lastErrorLogAt = -Infinity;
function warnThrottled(err: unknown): void {
  const now = Date.now();
  if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
  lastErrorLogAt = now;
  logger.warn({ err }, 'worker Redis connection error');
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

let redisInstance: Redis | null = null;
let bullRedisInstance: Redis | null = null;
let patientRedisInstance: Redis | null = null;

export function initRedis(
  url: string,
  tuning: RedisTuning = {},
): { redis: Redis; bullRedis: Redis; patientRedis: Redis } {
  if (!redisInstance) {
    const options: RedisOptions = {
      commandTimeout: tuning.commandTimeoutMs ?? REDIS_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      retryStrategy: (times: number) => Math.min(times * 50, 500),
    };
    redisInstance = bound(createRedisConnection(url, options));
  }
  if (!bullRedisInstance) {
    bullRedisInstance = createBullRedisConnection(url);
  }
  if (!patientRedisInstance) {
    patientRedisInstance = createRedisConnection(url);
    patientRedisInstance.on('error', warnThrottled);
  }
  return { redis: redisInstance, bullRedis: bullRedisInstance, patientRedis: patientRedisInstance };
}

/** Finite commands only. Rejects RedisUnavailableError on a transport failure or deadline. */
export function getRedis(): Redis {
  if (!redisInstance) throw new Error('Redis not initialized');
  return redisInstance;
}

/** Boot bookkeeping, socket-lifetime work and CLI exit frames: waits out outages, with no command deadline. */
export function getPatientRedis(): Redis {
  if (!patientRedisInstance) throw new Error('Patient Redis not initialized');
  return patientRedisInstance;
}

export function getBullRedis(): Redis {
  if (!bullRedisInstance) throw new Error('Bull Redis not initialized');
  return bullRedisInstance;
}

export async function closeRedis(): Promise<void> {
  await Promise.all(
    [redisInstance, bullRedisInstance, patientRedisInstance].map(
      (conn) => conn && quitOrDisconnect(conn),
    ),
  );
  redisInstance = null;
  bullRedisInstance = null;
  patientRedisInstance = null;
}

function quitOrDisconnect(conn: Redis): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.disconnect();
      resolve();
    }, QUIT_WAIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    void conn.quit().then(done, () => {
      conn.disconnect();
      done();
    });
  });
}
