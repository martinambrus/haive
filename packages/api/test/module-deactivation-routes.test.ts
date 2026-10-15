import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  anonymous: false,
  deactivated: new Set<string>(),
  reads: 0,
  intentRows: [] as unknown[],
  stored: new Map<string, string>(),
  toggle: { kind: 'missing' } as unknown,
  toggles: [] as unknown[],
  urgent: { kind: 'missing' } as unknown,
  urgents: [] as unknown[],
  audits: [] as unknown[],
}));

vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...original,
    requireAuth: async (
      c: { set: (key: string, value: string) => void },
      next: () => Promise<void>,
    ) => {
      if (h.anonymous)
        return (original.requireAuth as (c: unknown, n: unknown) => unknown)(c, next);
      c.set('userId', '00000000-0000-4000-8000-0000000000a1');
      c.set('userRole', h.role);
      await next();
    },
  };
});
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    set: async (key: string, value: string) => {
      h.stored.set(key, value);
    },
    setIfAbsent: async () => undefined,
  },
}));
vi.mock('../src/db.js', () => ({
  getDb: () => ({ select: () => ({ from: async () => h.intentRows }) }),
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ get: async () => null }) }));
vi.mock('../src/lib/audit.js', () => ({
  recordAuditEvent: async (_db: unknown, event: unknown) => void h.audits.push(event),
}));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => {
    h.reads += 1;
    return h.deactivated;
  },
  isModuleDeactivated: async (_db: unknown, id: string) => {
    h.reads += 1;
    return h.deactivated.has(id);
  },
  setModuleActive: async (_db: unknown, id: string, active: boolean) => {
    h.toggles.push([id, active]);
    return h.toggle;
  },
  deactivateUrgently: async (_db: unknown, id: string, actor: string) => {
    h.urgents.push([id, actor]);
    return h.urgent;
  },
}));

import { Hono } from 'hono';
import type { Database } from '@haive/database';
import { moduleManifestSchema } from '@haive/shared/modularity';
import { mountModules, moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const settings = {
  form: { title: 'Settings', fields: [{ id: 'limit', type: 'text', label: 'Limit' }] },
  defaults: { limit: '5' },
};

const manifestOf = (id: string, extra: Record<string, unknown> = {}) =>
  moduleManifestSchema.parse({
    id,
    name: id,
    version: '1.0.0',
    schemaVersion: 1,
    nav: [{ href: `/m/${id}`, label: id }],
    globalSettings: settings,
    ...extra,
  });

const routesOf = (id: string) => () =>
  new Hono<AppEnv>()
    .get('/x', (c) => c.json({ module: id }))
    .post('/x', (c) => c.json({ module: id }));

async function buildApp() {
  const app = new Hono<AppEnv>();
  const loaded = await mountModules(
    app,
    [
      {
        packageName: '@haive/module-alpha',
        manifest: manifestOf('alpha'),
        routes: routesOf('alpha'),
      },
      { packageName: '@haive/module-beta', manifest: manifestOf('beta'), routes: routesOf('beta') },
      {
        packageName: '@haive/module-gamma',
        manifest: manifestOf('gamma', { apiRequiresAdmin: true }),
        routes: routesOf('gamma'),
      },
    ],
    { db: {} as Database },
  );
  app.route('/modules', moduleRoutes(loaded));
  app.onError(errorHandler);
  return app;
}

const read = async (app: Hono<AppEnv>, path: string, init?: RequestInit) => {
  const res = await app.request(path, init);
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
};

beforeEach(() => {
  h.role = 'admin';
  h.anonymous = false;
  h.deactivated = new Set();
  h.reads = 0;
  h.intentRows = [];
  h.stored = new Map();
  h.toggle = { kind: 'missing' };
  h.toggles = [];
  h.urgent = { kind: 'missing' };
  h.urgents = [];
  h.audits = [];
});

describe('/m/<id> for a deactivated module', () => {
  it.each(['admin', 'user'])(
    'role %s: answers it exactly as it answers a module that does not exist',
    async (role) => {
      const app = await buildApp();
      h.role = role;
      h.deactivated = new Set(['alpha', 'gamma']);
      for (const init of [undefined, { method: 'POST' }]) {
        const unknown = await read(app, '/m/ghost/x', init);
        expect(unknown.status).toBe(404);
        for (const path of ['/m/alpha', '/m/alpha/x', '/m/alpha/deep/er', '/m/gamma/x']) {
          expect(await read(app, path, init)).toEqual(unknown);
        }
      }
    },
  );

  it('leaves an active module as it was, the admin-only one included', async () => {
    const app = await buildApp();
    h.deactivated = new Set(['alpha']);
    expect(await read(app, '/m/beta/x')).toMatchObject({
      status: 200,
      body: JSON.stringify({ module: 'beta' }),
    });
    h.role = 'user';
    expect((await read(app, '/m/gamma/x')).status).toBe(403);
    h.deactivated = new Set(['alpha', 'gamma']);
    expect((await read(app, '/m/gamma/x')).status).toBe(404);
  });

  it('asks for a login first and reads nothing for a request with no session', async () => {
    const app = await buildApp();
    h.anonymous = true;
    const active = await read(app, '/m/alpha/x');
    expect(active.status).toBe(401);
    h.deactivated = new Set(['alpha']);
    expect(await read(app, '/m/alpha/x')).toEqual(active);
    expect(h.reads).toBe(0);
  });
});

describe('GET /modules', () => {
  const idsFor = async (role: string) => {
    h.role = role;
    const res = await (await buildApp()).request('/modules');
    return ((await res.json()) as { modules: { id: string }[] }).modules.map((m) => m.id);
  };

  it.each(['admin', 'user'])(
    'role %s: lists every module while none is deactivated',
    async (role) => {
      expect(await idsFor(role)).toEqual(['alpha', 'beta', 'gamma']);
    },
  );

  it.each(['admin', 'user'])('role %s: leaves a deactivated module out', async (role) => {
    h.deactivated = new Set(['alpha', 'gamma']);
    expect(await idsFor(role)).toEqual(['beta']);
  });
});

describe('/modules/:id/settings/:kind for a deactivated module', () => {
  const put = { method: 'PUT', body: JSON.stringify({ values: { limit: '9' } }) };

  it('answers GET and PUT as it answers a module that does not exist', async () => {
    const app = await buildApp();
    h.deactivated = new Set(['alpha']);
    for (const init of [undefined, put]) {
      const unknown = await read(app, '/modules/ghost/settings/global', init);
      expect(unknown.status).toBe(404);
      expect(await read(app, '/modules/alpha/settings/global', init)).toEqual(unknown);
    }
    expect(h.stored.size).toBe(0);
  });

  it('still serves an active module', async () => {
    const app = await buildApp();
    h.deactivated = new Set(['alpha']);
    expect((await read(app, '/modules/beta/settings/global')).status).toBe(200);
    expect((await read(app, '/modules/beta/settings/global', put)).status).toBe(200);
  });
});

describe('GET /modules/loaded', () => {
  it('lists a deactivated module with when it was deactivated', async () => {
    const off = new Date('2026-10-14T08:00:00.000Z');
    h.intentRows = [
      {
        moduleId: 'alpha',
        packageName: '@haive/module-alpha',
        name: 'alpha',
        source: 'local',
        installedVersion: '1.0.0',
        entitlementId: null,
        firstLoadedAt: off,
        lastLoadedAt: off,
        missingAt: null,
        deactivatedAt: off,
        tornDownAt: null,
        updatedAt: off,
      },
    ];
    h.deactivated = new Set(['alpha']);
    const res = await (await buildApp()).request('/modules/loaded');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      intent: { moduleId: string; deactivatedAt: string }[];
      modules: { rows: { id: string; deactivatedAt: string | null }[] };
    };
    expect(body.intent[0]).toMatchObject({ moduleId: 'alpha', deactivatedAt: off.toISOString() });
    expect(body.modules.rows.map((r) => [r.id, r.deactivatedAt])).toEqual([
      ['alpha', off.toISOString()],
      ['beta', null],
      ['gamma', null],
    ]);
  });
});

describe('PATCH /modules/:id', () => {
  const patch = async (id: string, body: unknown) =>
    (await buildApp()).request(`/modules/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses a user before it reads or changes anything', async () => {
    h.role = 'user';
    const res = await patch('alpha', { active: false });
    expect(res.status).toBe(403);
    expect(h.toggles).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it.each([
    {},
    { active: 'no' },
    { active: null },
    { active: false, extra: 1 },
    { Active: false },
    { active: true, mode: 'urgent' },
    { active: false, mode: 'graceful' },
    { active: false, mode: 'urgent', extra: 1 },
  ])('refuses the body %j', async (body) => {
    const res = await patch('alpha', body);
    expect(res.status).toBe(400);
    expect(h.toggles).toEqual([]);
  });

  it('answers 404 for a module with no recorded row, and audits nothing', async () => {
    h.toggle = { kind: 'missing' };
    const res = await patch('ghost', { active: false });
    expect(res.status).toBe(404);
    expect(h.toggles).toEqual([['ghost', false]]);
    expect(h.audits).toEqual([]);
  });

  it('answers 409 with the live tasks that use the module, and audits nothing', async () => {
    const tasks = [
      { id: 't1', title: 'T', status: 'running', ownerId: 'u1', currentStepId: 'module.alpha.x' },
    ];
    h.toggle = { kind: 'open', tasks, capped: true };
    const res = await patch('alpha', { active: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: 'module_tasks_open',
      tasks,
      capped: true,
    });
    expect(h.audits).toEqual([]);
  });

  it('answers 404 for an urgent request on a module with no recorded row, and audits nothing', async () => {
    const res = await patch('ghost', { active: false, mode: 'urgent' });
    expect(res.status).toBe(404);
    expect(h.urgents).toEqual([['ghost', '00000000-0000-4000-8000-0000000000a1']]);
    expect(h.toggles).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('answers an urgent request with what it stopped and left, and audits its mode', async () => {
    const stopped = [
      { id: 't1', title: 'A', killed: 1, cancelled: 1, stopped: 1, eventError: 'event refused' },
    ];
    const left = [{ id: 't2', title: 'B', status: 'running', currentStepId: '07-x' }];
    const failed = [{ id: 't3', error: 'refused' }];
    h.urgent = {
      kind: 'ok',
      deactivatedAt: new Date('2026-10-14T08:00:00.000Z'),
      stopped,
      left,
      failed,
      capped: true,
    };
    const res = await patch('alpha', { active: false, mode: 'urgent' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      moduleId: 'alpha',
      active: false,
      deactivatedAt: '2026-10-14T08:00:00.000Z',
      stopped,
      left,
      failed,
      capped: true,
    });
    expect(h.toggles).toEqual([]);
    expect(h.audits).toEqual([
      {
        actorUserId: '00000000-0000-4000-8000-0000000000a1',
        action: 'module.deactivate',
        targetType: 'module',
        targetId: null,
        metadata: { moduleId: 'alpha', mode: 'urgent', stopped: 1 },
      },
    ]);
  });

  it.each<[boolean, string, string | null]>([
    [false, 'module.deactivate', '2026-10-14T08:00:00.000Z'],
    [true, 'module.activate', null],
  ])('answers 200 and audits for active=%s', async (active, action, stamp) => {
    h.toggle = { kind: 'ok', deactivatedAt: stamp === null ? null : new Date(stamp) };
    const res = await patch('alpha', { active });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ moduleId: 'alpha', active, deactivatedAt: stamp });
    expect(h.toggles).toEqual([['alpha', active]]);
    expect(h.audits).toEqual([
      {
        actorUserId: '00000000-0000-4000-8000-0000000000a1',
        action,
        targetType: 'module',
        targetId: null,
        metadata: { moduleId: 'alpha' },
      },
    ]);
  });
});
