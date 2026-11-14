import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('postgres', async (original) => {
  const actual = await original<typeof import('postgres')>();
  return {
    ...actual,
    default: vi.fn((...args: Parameters<typeof postgres>) => {
      // Exercise the real parser (including its file reads), but never dial.
      const parsed = actual.default(...args);
      void parsed.end({ timeout: 0 });
      return Object.assign(
        () => (h.error ? Promise.reject(h.error) : Promise.resolve([{ ok: 1 }])),
        { end: async () => {} },
      );
    }),
  };
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
}));
import { toolingRoutes } from '../src/routes/tooling.js';
import { globalKbRoutes } from '../src/routes/global-kb.js';

afterEach(() => {
  h.error = null;
  vi.mocked(postgres).mockClear();
});
const app = new Hono().route('/tooling', toolingRoutes).route('/global-kb', globalKbRoutes);
const probe = async (route: string, connectionString: string) => {
  const response = await app.request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'external', connectionString }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: boolean; error?: string; message?: string };
};

it.each(
  ['/tooling/test-postgres', '/global-kb/test-db'].flatMap((route) =>
    ['existing', 'nonexistent'].map((file) => ({ route, file })),
  ),
)(
  '$route refuses a $file file DSN without a file-existence oracle or a driver call',
  async ({ route, file }) => {
    const existing = fileURLToPath(new URL('../package.json', import.meta.url));
    const path = file === 'existing' ? existing : `${existing}.absent`;
    const result = await probe(
      route,
      `postgres://user@db.invalid/store?sslrootcert=${encodeURIComponent(path)}`,
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? result.message).toBe(
      'PostgreSQL connection parameter "sslrootcert" is not allowed',
    );
    expect(postgres).not.toHaveBeenCalled();
  },
);

it.each(['/tooling/test-postgres', '/global-kb/test-db'])(
  '%s hides real parser diagnostics',
  async (route) => {
    const result = await probe(
      route,
      'postgres://user@db.invalid/store?target_session_attrs=%2Fprivate%2Fdriver-file',
    );
    expect(result.error ?? result.message).toBe('PostgreSQL connection failed');
  },
);

it.each(['/tooling/test-postgres', '/global-kb/test-db'])(
  '%s never exposes file paths from parser, TLS, or server errors',
  async (route) => {
    for (const code of ['ENOENT', 'EACCES', 'ERR_TLS_CERT_ALTNAME_INVALID', 'XX000', undefined]) {
      h.error = Object.assign(new Error("driver failure at '/private/driver-file'"), { code });
      const result = await probe(route, 'postgres://user@db.invalid/store');
      expect(result.error ?? result.message).toBe('PostgreSQL connection failed');
    }
  },
);
