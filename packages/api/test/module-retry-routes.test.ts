import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  retry: { kind: 'missing' } as unknown,
  retryError: null as unknown,
  retries: [] as unknown[],
  order: [] as string[],
  publishes: [] as unknown[][],
  publishImpl: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...original,
    requireAuth: async (
      c: { set: (key: string, value: string) => void },
      next: () => Promise<void>,
    ) => {
      c.set('userId', '00000000-0000-4000-8000-0000000000a1');
      c.set('userRole', h.role);
      await next();
    },
  };
});
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async () => null,
    set: async () => undefined,
    setIfAbsent: async () => undefined,
  },
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    select: () => ({ from: async () => [] }),
    transaction: async (run: (tx: unknown) => unknown) => {
      const tx = {
        execute: async () => [],
        transaction: (inner: (t: unknown) => unknown) => inner(tx),
      };
      return run(tx);
    },
  }),
}));
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({
    get: async () => null,
    publish: (...args: unknown[]) => {
      h.order.push('publish');
      h.publishes.push(args);
      return h.publishImpl ? h.publishImpl(...args) : Promise.resolve(1);
    },
  }),
}));
vi.mock('../src/lib/audit.js', () => ({
  recordAuditEvent: async () => undefined,
  insertAuditEvent: async () => undefined,
  logAuditEvent: () => {},
}));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => new Set<string>(),
  isModuleDeactivated: async () => false,
  liveDependents: async () => ({ tasks: [], capped: false }),
  setModuleActive: async () => ({ kind: 'missing' }),
  deactivateUrgently: async () => ({ kind: 'missing' }),
  requestModuleRetry: async (_db: unknown, id: string, actor: string) => {
    h.retries.push([id, actor]);
    h.order.push('helper');
    if (h.retryError) throw h.retryError;
    return h.retry;
  },
}));

import { Hono } from 'hono';
import { MODULE_ACTIVATED_CHANNEL } from '@haive/shared/modularity';
import { moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/modules', moduleRoutes([]));
app.onError(errorHandler);

const post = async (path = '/modules/alpha/retry') => {
  const res = await app.request(path, { method: 'POST' });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body };
};

const lockTimeout = () =>
  Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

beforeEach(() => {
  h.role = 'admin';
  h.retry = { kind: 'missing' };
  h.retryError = null;
  h.retries = [];
  h.order = [];
  h.publishes = [];
  h.publishImpl = null;
});

describe('POST /modules/:id/retry', () => {
  it('A1 answers 200 with the module id and asks the helper once with the id and the admin', async () => {
    h.retry = { kind: 'ok' };
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moduleId: 'alpha' });
    expect(h.retries).toEqual([['alpha', ADMIN]]);
  });

  it('A2 publishes once on the activation channel after the helper, and never on any other outcome', async () => {
    h.retry = { kind: 'ok' };
    expect((await post()).status).toBe(200);
    expect(h.publishes).toEqual([[MODULE_ACTIVATED_CHANNEL, 'alpha']]);
    expect(h.order).toEqual(['helper', 'publish']);

    h.publishes = [];
    h.retry = { kind: 'missing' };
    await post();
    h.retry = { kind: 'inactive' };
    await post();
    h.retry = { kind: 'ok' };
    h.role = 'user';
    await post();
    h.role = 'admin';
    h.retryError = new Error('boom');
    await post();
    h.retryError = lockTimeout();
    await post();
    expect(h.publishes).toEqual([]);
  });

  it('A3 refuses a role user with 403 without calling the helper', async () => {
    h.retry = { kind: 'ok' };
    h.role = 'user';
    expect((await post()).status).toBe(403);
    expect(h.retries).toEqual([]);
  });

  it('A4 answers 404 for a missing module after asking the helper about that id', async () => {
    h.retry = { kind: 'missing' };
    expect((await post()).status).toBe(404);
    expect(h.retries).toEqual([['alpha', ADMIN]]);
  });

  it('A5 answers 409 with code module_inactive for a deactivated module', async () => {
    h.retry = { kind: 'inactive' };
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'module_inactive' });
    expect(h.retries).toEqual([['alpha', ADMIN]]);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('redis down'))],
    [
      'throws synchronously',
      () => {
        throw new Error('redis gone');
      },
    ],
  ])('A6 keeps the 200 when the publish %s', async (_name, impl) => {
    h.retry = { kind: 'ok' };
    h.publishImpl = impl;
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moduleId: 'alpha' });
    expect(h.publishes).toHaveLength(1);
  });

  it('A7 answers 503 module-busy for a lock timeout and 500 for any other helper error, publishing nothing', async () => {
    h.retryError = lockTimeout();
    const busy = await post();
    expect(busy.status).toBe(503);
    expect(busy.body).toMatchObject({ code: 'module-busy' });
    expect(h.retries).toHaveLength(1);

    h.retryError = new Error('boom');
    expect((await post()).status).toBe(500);
    expect(h.retries).toHaveLength(2);
    expect(h.publishes).toEqual([]);
  });

  it('A8 guard: a GET on the path stays 404 and never reaches the helper', async () => {
    h.retry = { kind: 'ok' };
    const res = await app.request('/modules/alpha/retry');
    expect(res.status).toBe(404);
    expect(h.retries).toEqual([]);
  });
});
