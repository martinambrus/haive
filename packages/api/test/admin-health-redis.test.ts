import { describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const h = vi.hoisted(() => ({ getRedis: (() => undefined) as () => unknown }));

const chain = (): unknown => {
  const t: Record<string, unknown> = {
    then: (resolve: (v: unknown[]) => unknown) => resolve([]),
  };
  for (const m of ['select', 'from', 'where', 'groupBy', 'orderBy', 'limit']) t[m] = () => t;
  return t;
};

vi.mock('../src/db.js', () => ({ getDb: () => chain() }));
vi.mock('../src/redis.js', () => ({ getRedis: () => h.getRedis() }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN);
    c.set('userRole', 'admin');
    await next();
  },
}));

import { Hono } from 'hono';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { RedisUnavailableError } from '../src/lib/redis-unavailable.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.onError(errorHandler);

async function health(): Promise<Record<string, unknown>> {
  const res = await app.request('/admin/health');
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.users).toBeDefined();
  expect(body.tasks).toBeDefined();
  expect(body.containers).toBeDefined();
  expect(Array.isArray(body.recentFailures)).toBe(true);
  expect(typeof body.timestamp).toBe('string');
  return body;
}

describe('GET /admin/health reports Redis', () => {
  it('says up when the ping resolves', async () => {
    h.getRedis = () => ({ ping: async () => 'PONG' });
    expect((await health()).redis).toBe('up');
  });

  it('says down when the ping rejects with RedisUnavailableError', async () => {
    h.getRedis = () => ({
      ping: async () => {
        throw new RedisUnavailableError(new Error('x'));
      },
    });
    expect((await health()).redis).toBe('down');
  });

  it('says down when getRedis throws synchronously', async () => {
    h.getRedis = () => {
      throw new Error('not initialised');
    };
    expect((await health()).redis).toBe('down');
  });

  it('says down when the ping gets a server error reply', async () => {
    h.getRedis = () => ({
      ping: async () => {
        throw new Error('LOADING');
      },
    });
    expect((await health()).redis).toBe('down');
  });
});
