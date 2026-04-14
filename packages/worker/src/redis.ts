import type { Redis } from 'ioredis';
import { createRedisConnection, createBullRedisConnection } from '@haive/shared';

let redisInstance: Redis | null = null;
let bullRedisInstance: Redis | null = null;

export function initRedis(url: string): { redis: Redis; bullRedis: Redis } {
  if (!redisInstance) {
    redisInstance = createRedisConnection(url);
  }
  if (!bullRedisInstance) {
    bullRedisInstance = createBullRedisConnection(url);
  }
  return { redis: redisInstance, bullRedis: bullRedisInstance };
}

export function getRedis(): Redis {
  if (!redisInstance) throw new Error('Redis not initialized');
  return redisInstance;
}

export function getBullRedis(): Redis {
  if (!bullRedisInstance) throw new Error('Bull Redis not initialized');
  return bullRedisInstance;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redisInstance?.quit(), bullRedisInstance?.quit()]);
  redisInstance = null;
  bullRedisInstance = null;
}
