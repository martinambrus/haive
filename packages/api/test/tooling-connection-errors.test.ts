import { Hono } from 'hono';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';

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

it.each(['127.0.0.1:1', 'haive-connection-control.invalid:1'])(
  'fix2 preserves real postgres.js connection diagnostics for %s through both routes',
  async (host) => {
    const connectionString = `postgres://synthetic:synthetic@${host}/connection_control`;
    const sql = postgres(connectionString, { max: 1, connect_timeout: 1 });
    let original: Error & { code?: string; parameters?: unknown[] };
    try {
      original = await sql`select 1`.catch((err) => err);
    } finally {
      await sql.end({ timeout: 5 });
    }
    expect(original! instanceof Error).toBe(true);
    expect(Object.hasOwn(original!, 'query')).toBe(true);
    expect((original!.parameters?.length ?? 0) === 0).toBe(true);
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
      const result = (await response.json()) as { error?: string; message?: string };
      expect((result.error ?? result.message) === original!.message).toBe(true);
    }
  },
  30_000,
);
