import { Redis, type RedisOptions } from 'ioredis';

export interface RedisFactoryOptions extends RedisOptions {
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number | null;
}

export function createRedisConnection(url: string, overrides: RedisFactoryOptions = {}): Redis {
  return new Redis(url, {
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    ...overrides,
  });
}

export function createBullRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
