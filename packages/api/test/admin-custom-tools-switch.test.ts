import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  stored: new Map<string, string>(),
  writes: [] as Array<[string, string]>,
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    transaction: async (run: (tx: unknown) => unknown) => {
      const tx = {
        execute: async () => [],
        insert: () => ({ values: async () => undefined }),
        transaction: (inner: (t: unknown) => unknown) => inner(tx),
      };
      return run(tx);
    },
  }),
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async (key: string) => h.stored.get(key) ?? null,
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    getBoolean: async (key: string, fallback = false) => {
      const value = h.stored.get(key);
      return value === undefined ? fallback : value === 'true' || value === '1';
    },
    set: async (key: string, value: string) => {
      h.writes.push([key, value]);
      h.stored.set(key, value);
    },
  },
}));

import { Hono } from 'hono';
import { CONFIG_KEYS } from '@haive/shared';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.onError(errorHandler);

const send = (method: string, body?: unknown) =>
  app.request('/admin/config/custom-tools', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  h.role = 'admin';
  h.stored = new Map();
  h.writes = [];
});

describe('/admin/config/custom-tools', () => {
  it('A1 answers on by default, switches off and back, refuses a bad body, and is admin only', async () => {
    const first = await send('GET');
    expect(first.status, 'GET /admin/config/custom-tools').toBe(200);
    expect(await first.json()).toEqual({ enabled: true });

    const off = await send('PUT', { enabled: false });
    expect(off.status, 'PUT {enabled:false}').toBe(200);
    expect(await off.json()).toEqual({ enabled: false });
    expect(h.writes).toEqual([[CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED, 'false']]);
    expect(await (await send('GET')).json()).toEqual({ enabled: false });

    const on = await send('PUT', { enabled: true });
    expect(await on.json()).toEqual({ enabled: true });
    expect(h.writes.at(-1)).toEqual([CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED, 'true']);
    expect(await (await send('GET')).json()).toEqual({ enabled: true });

    h.writes = [];
    for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }, []]) {
      expect((await send('PUT', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.writes).toEqual([]);

    h.role = 'user';
    expect((await send('GET')).status).toBe(403);
    expect((await send('PUT', { enabled: false })).status).toBe(403);
    expect(h.writes).toEqual([]);
  });
});
