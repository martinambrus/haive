import { Redis, type RedisOptions } from 'ioredis';

export interface RedisFactoryOptions extends RedisOptions {
  enableOfflineQueue?: boolean;
  maxRetriesPerRequest?: number | null;
}

/** ioredis 6 switched the default wire protocol to RESP3. Both factories pin `protocol: 2`
 *  because RESP3 changes reply SHAPES, and this codebase reads replies positionally: the live
 *  cli-stream (`xadd`/`xread`), plus `hgetall`, `hset`, `zrange`, `mget` and the
 *  `multi`/`pipeline`/`exec` paths. BullMQ's own documentation never claims RESP3 support
 *  either. Adopting RESP3 is a separate, deliberate change that needs every reply site
 *  audited first; until then this keeps ioredis 6 on the ioredis 5 wire format.
 *
 *  These two functions are the ONLY places a Redis client is constructed in the workspace —
 *  every other module imports `Redis` as a type only — so pinning here covers everything. */

export function createRedisConnection(url: string, overrides: RedisFactoryOptions = {}): Redis {
  return new Redis(url, {
    protocol: 2,
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    ...overrides,
  });
}

export function createBullRedisConnection(url: string): Redis {
  return new Redis(url, {
    protocol: 2,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
