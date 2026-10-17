import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const h = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  audits: [] as unknown[],
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    transaction: async (run: (tx: unknown) => unknown) => {
      const tx = {
        execute: async () => [],
        transaction: (inner: (t: unknown) => unknown) => inner(tx),
      };
      return run(tx);
    },
  }),
}));
vi.mock('../src/lib/audit.js', () => ({
  recordAuditEvent: async (_db: unknown, event: unknown) => void h.audits.push(event),
  insertAuditEvent: async (_db: unknown, event: unknown) => void h.audits.push(event),
  logAuditEvent: () => {},
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN_ID);
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    getBoolean: async (key: string, fallback = false) => {
      const value = h.stored.get(key);
      return value === undefined ? fallback : value === 'true';
    },
    set: async (key: string, value: string) => void h.stored.set(key, value),
  },
}));

import { Hono } from 'hono';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.onError(errorHandler);

const put = (body: unknown) =>
  app.request('/admin/config/custom-tools', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const flip = (from: boolean, to: boolean) => ({
  actorUserId: ADMIN_ID,
  action: 'config.custom_tools',
  targetType: 'system',
  metadata: { from, to },
});

beforeEach(() => {
  h.stored = new Map();
  h.audits = [];
});

describe('PUT /admin/config/custom-tools audit', () => {
  it('records who switched custom tools, with the value before and after', async () => {
    await put({ enabled: false });
    await put({ enabled: true });
    expect(h.audits).toEqual([flip(true, false), flip(false, true)]);
  });

  it('records nothing for a body it refuses', async () => {
    expect((await put({ enabled: 'false' })).status).toBe(400);
    expect(h.audits).toEqual([]);
  });
});
