import { describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b2';
const h = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('../src/db.js', () => ({ getDb: () => ({ execute: async () => h.rows }) }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN);
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

import { Hono } from 'hono';
import { adminRoutes } from '../src/routes/admin.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/admin', adminRoutes);
app.onError(errorHandler);

describe('GET /admin/config/codex-app-server', () => {
  it('names the viewer beside the failures, each with the owner of its task', async () => {
    h.rows = [{ taskId: 't1', taskTitle: 'a task', ownerId: OWNER, providerId: 'p1' }];
    const res = await app.request('/admin/config/codex-app-server');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, viewerId: ADMIN, recentFailures: h.rows });
  });
});
