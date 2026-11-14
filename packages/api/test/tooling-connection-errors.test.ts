import { Hono } from 'hono';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: null as Error | null }));

// Pass each stable driver error class through both route sinks without a real dial.
vi.mock('postgres', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  return {
    ...actual,
    default: (...args: Parameters<typeof postgres>) => {
      if (!h.error) return actual.default(...args);
      return Object.assign(() => Promise.reject(h.error), { end: async () => {} });
    },
  };
});
afterEach(() => {
  h.error = null;
  vi.useRealTimers();
});

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'test-user');
    c.set('userRole', 'admin');
    await next();
  },
}));
vi.mock('../src/lib/probe-hosts.js', () => ({ probeEgressFor: async () => ({}) }));
vi.mock('@haive/shared/global-kb', async (original) => ({
  ...(await original<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => ({ mode: 'external' }),
  resolveGlobalKbConnection: async (settings: { connectionString: string }) => {
    const pg = postgres(settings.connectionString, { max: 1, connect_timeout: 1 });
    return { pg, close: () => pg.end({ timeout: 5 }) };
  },
}));

import { toolingRoutes } from '../src/routes/tooling.js';
import { globalKbRoutes } from '../src/routes/global-kb.js';

it.each([
  ['ECONNREFUSED', 'PostgreSQL connection refused'],
  ['ENOTFOUND', 'PostgreSQL host could not be resolved'],
  ['EAI_AGAIN', 'PostgreSQL host could not be resolved'],
  ['CONNECT_TIMEOUT', 'PostgreSQL connection timed out'],
  ['ETIMEDOUT', 'PostgreSQL connection timed out'],
  ['28P01', 'PostgreSQL authentication failed'],
  ['28000', 'PostgreSQL authentication failed'],
])('returns fixed diagnostics for %s through both routes', async (code, message) => {
  const connectionString = `postgres://user:${randomBytes(12).toString('hex')}@db.invalid/connection_control`;
  h.error = Object.assign(new Error("driver failure at '/private/driver-file'"), {
    code,
    query: 'select 1',
    parameters: [],
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const app = new Hono().route('/tooling', toolingRoutes).route('/global-kb', globalKbRoutes);
  for (const route of ['/tooling/test-postgres', '/global-kb/test-db']) {
    const response = await app.request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionString,
        ...(route.includes('test-db') ? { mode: 'external' } : {}),
      }),
    });
    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    const result = (await response.json()) as { error?: string; message?: string };
    expect(result.error ?? result.message).toBe(message);
  }
});
