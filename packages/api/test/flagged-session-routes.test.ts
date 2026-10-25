import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
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
  return { reached, unreachable, db: undefined as unknown };
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
    getEncryptionKey: async () => 'ab'.repeat(32),
    setIfAbsent: async () => undefined,
  },
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({
  getRedis: () => h.unreachable('redis'),
  getBullRedis: () => h.unreachable('bull redis'),
}));
vi.mock('../src/queues.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/queues.js')>();
  return Object.fromEntries(Object.keys(real).map((name) => [name, () => h.unreachable(name)]));
});

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { encryptEmail, secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { requireAdmin, requireAuth } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const { createApiApp } = await import('../src/index.js');
const { installModules } = await import('../src/modules/loader.js');
const { getDb } = await import('../src/db.js');

const MUST_CHANGE = 'must_change_password';
const FLAGGED = '00000000-0000-4000-8000-0000000000f1';
const UUID = '00000000-0000-4000-8000-000000000001';
const NO_ROUTE = 'x-no-route';

const PUBLIC: Record<string, string> = {
  'GET /health': 'liveness probe; the container health check carries no credential',
  'GET /version': 'an upgrade verifies the containers it swapped in before any credential exists',
  'GET /auth/registration-status':
    'the setup page asks whether the install still needs its first account',
  'POST /auth/register': 'creates an account for a caller who has no session yet',
  'POST /auth/login': 'issues the session, so the caller has none yet',
  'POST /auth/logout':
    'revokes the refresh token the caller presents, and must work once the access token is revoked',
  'POST /auth/refresh':
    'redeems the refresh cookie rather than a session, so a flagged user can still renew their tokens',
};

const EXEMPT: Record<string, string> = {
  'GET /auth/me':
    'the app layout reads mustChangePassword here to send the user to the change form',
  'PUT /user-settings/password': 'the only way a flagged user clears the flag',
};

interface Answer {
  status: number | 'no answer';
  code: unknown;
  noRoute: boolean;
  reached: string[];
}

interface Row {
  key: string;
  anonymous: Answer;
  flagged: Answer;
}

function concrete(path: string): string {
  if (path.includes('{')) {
    throw new Error(`${path} constrains a parameter; give the sweep a value that matches it`);
  }
  return path.replace(/:\w+\??/g, UUID).replace(/\*/g, 'x');
}

function userLookupOnly(db: unknown): unknown {
  const record = (what: string): never => {
    h.reached.push(what);
    throw new Error(`${what} reached`);
  };
  const fake = db as { query: Record<string, Record<string, unknown>> };
  return new Proxy(fake, {
    get(target, prop) {
      if (prop !== 'query') return record(`db.${String(prop)}`);
      return new Proxy(target.query, {
        get(tables, table) {
          if (table !== 'users') return record(`db.query.${String(table)}`);
          return new Proxy(tables.users!, {
            get(users, method) {
              if (method === 'findFirst') return users.findFirst;
              return record(`db.query.users.${String(method)}`);
            },
          });
        },
      });
    },
  });
}

async function ask(app: Hono<AppEnv>, method: string, path: string, cookie?: string) {
  const verb = method === 'ALL' ? 'GET' : method;
  h.reached.length = 0;
  const res = await Promise.race([
    app.request(concrete(path), {
      method: verb,
      headers: {
        host: 'localhost:3001',
        ...(cookie ? { cookie } : {}),
        ...(verb === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(verb === 'GET' ? {} : { body: '{}' }),
    }),
    new Promise<null>((resolve) => setTimeout(resolve, 5_000, null).unref()),
  ]);
  const code = await res?.json().then(
    (body) => (body as { code?: unknown } | null)?.code,
    () => undefined,
  );
  await res?.body?.cancel().catch(() => undefined);
  return {
    status: res?.status ?? 'no answer',
    code,
    noRoute: res?.headers.has(NO_ROUTE) ?? false,
    reached: [...h.reached],
  } satisfies Answer;
}

async function sweep(app: Hono<AppEnv>, flaggedCookie: string): Promise<Row[]> {
  app.notFound((c) => c.body(null, 404, { [NO_ROUTE]: '1' }));
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const { method, path } of app.routes) {
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      anonymous: await ask(app, method, path),
      flagged: await ask(app, method, path, flaggedCookie),
    });
  }
  return rows;
}

const refused = (a: Answer) =>
  a.reached.length === 0 && (a.status === 401 || a.status === 403 || a.noRoute);
const isGate = (a: Answer) => a.status === 403 && a.code === MUST_CHANGE;

const sessionGated = (r: Row) =>
  refused(r.anonymous) && isGate(r.flagged) && r.flagged.reached.length === 0;
const bearerOnly = (r: Row) =>
  refused(r.anonymous) &&
  refused(r.flagged) &&
  !isGate(r.flagged) &&
  r.flagged.status === r.anonymous.status;

function show(row: Row): string {
  const answer = (a: Answer) => {
    const reached = a.reached.length > 0 ? ` after reaching ${a.reached.join(', ')}` : '';
    return `${a.noRoute ? 'no route matched' : a.status}${a.code ? ` ${String(a.code)}` : ''}${reached}`;
  };
  return `${row.key} -> no session ${answer(row.anonymous)}; flagged session ${answer(row.flagged)}`;
}

function judge(rows: Row[]) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const stale = (key: string, needsSession: boolean) => {
    const row = byKey.get(key);
    return row === undefined || isGate(row.flagged) || (needsSession && !refused(row.anonymous));
  };
  return {
    notRefusedForAFlaggedSession: rows
      .filter((r) => !(r.key in PUBLIC) && !(r.key in EXEMPT) && !sessionGated(r) && !bearerOnly(r))
      .map(show),
    staleAllowlistEntries: [
      ...Object.keys(PUBLIC).filter((key) => stale(key, false)),
      ...Object.keys(EXEMPT).filter((key) => stale(key, true)),
    ],
  };
}

async function build(role: 'admin' | 'user' = 'admin', mustChangePassword = true) {
  const fake = createFakeDb({ users: schema.users });
  fake.insert(schema.users, {
    id: FLAGGED,
    role,
    status: 'active',
    tokenVersion: 0,
    mustChangePassword,
    emailEncrypted: encryptEmail('flagged@sweep.test.local', 'ab'.repeat(32)),
  });
  h.db = userLookupOnly(fake.db);
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
  const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: FLAGGED, role: 'admin', tv: 0 })}`;
  const app = createApiApp('http://localhost:3000');
  return { app, cookie };
}

describe('a session that must change its password, across the api', () => {
  it('every route refuses it with must_change_password before it reads anything else, except the listed ones', async () => {
    const { app, cookie } = await build();
    await installModules(app);
    expect(
      judge(await sweep(app, cookie)),
      'gate the route behind the session check, or list it in EXEMPT / PUBLIC with its reason; drop an entry the route no longer needs',
    ).toEqual({ notRefusedForAFlaggedSession: [], staleAllowlistEntries: [] });
  }, 120_000);

  it('the verdict names a route that answers a flagged session with 200', async () => {
    const { app, cookie } = await build();
    app.get('/zz-open', (c) => c.json({ ok: true }));
    expect(judge(await sweep(app, cookie)).notRefusedForAFlaggedSession).toContain(
      'GET /zz-open -> no session 200; flagged session 200',
    );
  });

  it('the verdict names a route that reads the database before it refuses a flagged session', async () => {
    const { app, cookie } = await build();
    app.post('/zz-late', (c) => {
      if (!c.req.header('cookie')) return c.json({ error: 'Not authenticated' }, 401);
      try {
        getDb().select();
      } catch {
        // the recorder throws on every read; the route goes on to answer
      }
      return c.json({ error: 'late', code: MUST_CHANGE }, 403);
    });
    expect(judge(await sweep(app, cookie)).notRefusedForAFlaggedSession).toContain(
      'POST /zz-late -> no session 401; flagged session 403 must_change_password after reaching db.select',
    );
  });

  it('the verdict passes a route that refuses a flagged session with the gate and reads nothing', async () => {
    const { app, cookie } = await build();
    app.get('/zz-gated', (c) =>
      c.req.header('cookie')
        ? c.json({ error: 'change your password', code: MUST_CHANGE }, 403)
        : c.json({ error: 'Not authenticated' }, 401),
    );
    expect(
      judge(await sweep(app, cookie)).notRefusedForAFlaggedSession.filter((line) =>
        line.includes('/zz-gated'),
      ),
    ).toEqual([]);
  });

  it('the verdict is not a pass for a sweep that found no routes', () => {
    expect(judge([]).staleAllowlistEntries).toEqual([
      ...Object.keys(PUBLIC),
      ...Object.keys(EXEMPT),
    ]);
  });
});

// These policies are independent of the presence of requireAdmin, so removing a gate does not
// remove its routes from the sweep. Middleware scopes below also discover new admin surfaces.
const ADMIN_ENDPOINTS = new Set([
  'POST /global-kb/test-db',
  'PUT /global-kb/entries/:id/enforcement',
  'DELETE /global-kb/entries/:id/enforcement',
  'GET /modules/loaded',
  'PATCH /modules/:id',
  'POST /modules/:id/teardown',
  'POST /modules/:id/purge',
  'GET /modules/:id/settings/:kind',
  'PUT /modules/:id/settings/:kind',
]);

async function adminSweep(app: Hono<AppEnv>, cookie: string, extra: string[] = []) {
  const policies = new Set([...ADMIN_ENDPOINTS, ...extra]);
  const scopes = app.routes.filter((r) => r.handler === requireAdmin);
  const last = new Map(app.routes.map((r) => [`${r.method} ${r.path}`, r]));
  const endpoints = [...last.values()].filter(
    ({ method, path }) =>
      method !== 'ALL' &&
      (path === '/admin' ||
        path.startsWith('/admin/') ||
        path === '/cli-pricing' ||
        path.startsWith('/cli-pricing/') ||
        policies.has(`${method} ${path}`) ||
        scopes.some(
          (scope) =>
            (scope.method === 'ALL' || scope.method === method) &&
            (scope.path === path ||
              (scope.path.endsWith('/*') &&
                (path === scope.path.slice(0, -2) || path.startsWith(scope.path.slice(0, -1))))),
        )),
  );
  // Replay the builder's registrations in their original order, recording entry into the final
  // handler. This catches a handler that does work and then returns 403, even with no DB call.
  const tracked = new Set(endpoints);
  const probe = new Hono<AppEnv>().onError(errorHandler);
  for (const r of app.routes) {
    probe.on(
      r.method,
      r.path,
      tracked.has(r)
        ? async (c, next) => {
            h.reached.push(`handler ${r.method} ${r.path}`);
            return r.handler(c, next);
          }
        : r.handler,
    );
  }
  const rows: Array<Answer & { key: string }> = [];
  for (const { method, path } of endpoints) {
    const answer = await ask(probe, method, path.replace(':kind', 'admin'), cookie);
    rows.push({ key: `${method} ${path}`, ...answer });
    // Saving global module settings also requires an administrator.
    if (method === 'PUT' && path.includes(':kind')) {
      rows.push({
        key: `${method} ${path} (global)`,
        ...(await ask(probe, method, path.replace(':kind', 'global'), cookie)),
      });
    }
  }
  return {
    notRefusedBeforeHandler: rows
      .filter((r) => r.status !== 403 || r.reached.length > 0)
      .map(
        (r) =>
          `${r.key} -> ${r.status}${r.reached.length ? ` after reaching ${r.reached.join(', ')}` : ''}`,
      ),
    missingPolicies: [...policies].filter((key) => !rows.some((r) => r.key === key)),
    count: rows.length,
  };
}

describe('a signed-in non-admin across the admin api', () => {
  it('every admin endpoint answers 403 before its handler, database or queues run', async () => {
    // The signed token claims admin; requireAuth must use the current database role (user).
    const { app, cookie } = await build('user', false);
    await installModules(app);
    const verdict = await adminSweep(app, cookie);
    expect(verdict.count).toBeGreaterThan(30);
    expect(verdict).toMatchObject({ notRefusedBeforeHandler: [], missingPolicies: [] });
  });

  it('the verdict detects an endpoint missing its admin gate', async () => {
    const { app, cookie } = await build('user', false);
    app.get('/zz-admin-open', requireAuth, (c) => c.json({ ok: true }));
    const verdict = await adminSweep(app, cookie, ['GET /zz-admin-open']);
    expect(verdict.notRefusedBeforeHandler).toContain(
      'GET /zz-admin-open -> 200 after reaching handler GET /zz-admin-open',
    );
  });

  it('the verdict detects a handler that enters before returning 403', async () => {
    const { app, cookie } = await build('user', false);
    app.post('/zz-admin-late', requireAuth, (c) => c.json({ error: 'late' }, 403));
    const verdict = await adminSweep(app, cookie, ['POST /zz-admin-late']);
    expect(verdict.notRefusedBeforeHandler).toContain(
      'POST /zz-admin-late -> 403 after reaching handler POST /zz-admin-late',
    );
  });

  it('an empty route list fails the coverage policies', async () => {
    const { cookie } = await build('user', false);
    expect((await adminSweep(new Hono<AppEnv>(), cookie)).missingPolicies).toEqual([
      ...ADMIN_ENDPOINTS,
    ]);
  });
});
