import type { Redis } from 'ioredis';
import { createRedisConnection, createBullRedisConnection } from '@haive/shared';

const QUIT_WAIT_MS = 1_000;

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
  await Promise.all(
    [redisInstance, bullRedisInstance].map((conn) => conn && quitOrDisconnect(conn)),
  );
  redisInstance = null;
  bullRedisInstance = null;
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
    void conn.quit().then(done, done);
  });
}
