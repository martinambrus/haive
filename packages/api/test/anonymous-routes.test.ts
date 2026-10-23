import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  // The bearer-token routes read it before they look at the token and answer 500 without it.
  process.env.CONFIG_ENCRYPTION_KEY = 'ab'.repeat(32);
  const reached: string[] = [];
  const unreachable = (what: string) =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          reached.push(`${what}.${String(prop)}`);
          throw new Error(`${what} reached`);
        },
      },
    );
  return { reached, unreachable };
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  // maintenanceGate reads config on every request; that cached read is not a data touch.
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
    setIfAbsent: async () => undefined,
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.unreachable('db') }));
vi.mock('../src/redis.js', () => ({
  getRedis: () => h.unreachable('redis'),
  getBullRedis: () => h.unreachable('bull redis'),
}));
vi.mock('../src/queues.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/queues.js')>();
  return Object.fromEntries(Object.keys(real).map((name) => [name, () => h.unreachable(name)]));
});

const { createApiApp } = await import('../src/index.js');
const { installModules } = await import('../src/modules/loader.js');
const { getDb } = await import('../src/db.js');

const PUBLIC: Record<string, string> = {
  'GET /health': 'liveness probe; the container health check carries no credential',
  'GET /version': 'an upgrade verifies the containers it swapped in before any credential exists',
  'GET /auth/registration-status':
    'the setup page asks whether the install still needs its first account',
  'POST /auth/register': 'creates an account for a caller who has no session yet',
  'POST /auth/login': 'issues the session, so the caller has none yet',
  'POST /auth/logout':
    'revokes the refresh token the caller presents, and must work once the access token is revoked',
};

const NO_ROUTE = 'x-no-route';
const UUID = '00000000-0000-4000-8000-000000000001';

type Row = { key: string; status: number | 'no answer'; noRoute: boolean; reached: string[] };

function concrete(path: string): string {
  if (path.includes('{')) {
    throw new Error(`${path} constrains a parameter; give the sweep a value that matches it`);
  }
  return path.replace(/:\w+\??/g, UUID).replace(/\*/g, 'x');
}

async function sweep(app: Hono<AppEnv>): Promise<Row[]> {
  app.notFound((c) => c.body(null, 404, { [NO_ROUTE]: '1' }));
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const { method, path } of app.routes) {
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const verb = method === 'ALL' ? 'GET' : method;
    h.reached.length = 0;
    const res = await Promise.race([
      app.request(concrete(path), {
        method: verb,
        headers: {
          host: 'localhost:3001',
          ...(verb === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(verb === 'GET' ? {} : { body: '{}' }),
      }),
      new Promise<null>((resolve) => setTimeout(resolve, 5_000, null).unref()),
    ]);
    await res?.body?.cancel();
    rows.push({
      key,
      status: res?.status ?? 'no answer',
      noRoute: res?.headers.has(NO_ROUTE) ?? false,
      reached: [...h.reached],
    });
  }
  return rows;
}

const guarded = (row: Row) =>
  row.reached.length === 0 && (row.status === 401 || row.status === 403 || row.noRoute);

function show(row: Row): string {
  const reached = row.reached.length > 0 ? ` after reaching ${row.reached.join(', ')}` : '';
  return `${row.key} -> ${row.noRoute ? 'no route matched' : row.status}${reached}`;
}

function judge(rows: Row[]) {
  return {
    answeredAnonymously: rows.filter((r) => !guarded(r) && !(r.key in PUBLIC)).map(show),
    staleAllowlistEntries: Object.keys(PUBLIC).filter((key) => {
      const row = rows.find((r) => r.key === key);
      return row === undefined || guarded(row);
    }),
  };
}

describe('anonymous access to the api', () => {
  it('every route refuses a request with no session before it reads anything, except the public ones', async () => {
    const app = createApiApp('http://localhost:3000');
    await installModules(app);
    expect(
      judge(await sweep(app)),
      'put the route behind requireAuth, or list it in PUBLIC with its reason; drop a PUBLIC entry the route no longer needs',
    ).toEqual({ answeredAnonymously: [], staleAllowlistEntries: [] });
  }, 60_000);

  it('the verdict names a route that answers a request with no session', async () => {
    const app = createApiApp('http://localhost:3000');
    app.get('/zz-open', (c) => c.json({ ok: true }));
    expect(judge(await sweep(app)).answeredAnonymously).toContain('GET /zz-open -> 200');
  });

  it('the verdict names a route that reads the database before it refuses', async () => {
    const app = createApiApp('http://localhost:3000');
    app.post('/zz-late', (c) => {
      try {
        getDb().select();
      } catch {
        // the recorder throws on every read; the route goes on to answer 401
      }
      return c.json({ error: 'Not authenticated' }, 401);
    });
    expect(judge(await sweep(app)).answeredAnonymously).toContain(
      'POST /zz-late -> 401 after reaching db.select',
    );
  });

  it('the verdict is not a pass for a sweep that found no routes', () => {
    expect(judge([]).staleAllowlistEntries).toEqual(Object.keys(PUBLIC));
  });
});
