import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.MODULE_DEACTIVATION_API_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_deactivation_api_test'))
  throw new Error('Use a dedicated module_deactivation_api_test database for module route tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'admin',
  anonymous: false,
  stored: new Map<string, string>(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ get: async () => null }) }));
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
      c.set('userId', ACTOR);
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
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { Hono } from 'hono';
import { moduleManifestSchema, type ComposableStepEntry } from '@haive/shared/modularity';
import { mountModules, moduleRoutes } from '../src/modules/loader.js';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const USER_EMAIL_INDEX = 'module-deactivation-api-test-user';
const TYPE = 'mod-deact-test';
const LIVE = ['created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr'] as const;
const ENDED = ['completed', 'failed', 'cancelled'] as const;

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
const routesOf = (id: string) => () => new Hono<AppEnv>().get('/x', (c) => c.json({ module: id }));

const entry = (stepId: string, group: string): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group,
  dispatchesCli: false,
  requires: [],
  provides: [],
});
const catalogRow = (
  stepId: string,
  source: string,
  group: string,
): typeof schema.stepCatalog.$inferInsert => ({
  stepId,
  source,
  title: stepId,
  workflowType: 'workflow',
  dispatchesCli: false,
  allowSkip: false,
  providerSensitive: false,
  composable: true,
  entry: entry(stepId, group),
});

let selects = 0;
const app = new Hono<AppEnv>();
app.onError(errorHandler);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const patchModule = (id: string, active: boolean) => send('PATCH', `/modules/${id}`, { active });
const read = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
};

describe.skipIf(!url)('module deactivation on Postgres', () => {
  let db: Database;
  let userId: string;

  const setModule = (moduleId: string, deactivatedAt: Date | null = null) =>
    db.insert(schema.modules).values({
      moduleId,
      packageName: `@haive/module-${moduleId}`,
      name: moduleId,
      installedVersion: '1.0.0',
      deactivatedAt,
    });
  const stampOf = async (moduleId: string) =>
    (
      await db
        .select({ at: schema.modules.deactivatedAt })
        .from(schema.modules)
        .where(eq(schema.modules.moduleId, moduleId))
    )[0]?.at;
  const task = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: TYPE,
        title: 'Task',
        status: 'running',
        runListSnapshot: ['01-worktree-setup', 'module.alpha.x'],
        ...over,
      })
      .returning();
    return row!;
  };
  const rawSnapshot = (id: string, json: string) =>
    db.execute(sql`UPDATE tasks SET run_list_snapshot = ${json}::jsonb WHERE id = ${id}`);
  const audits = () =>
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'module'));

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') selects += 1;
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const loaded = await mountModules(
      app,
      [
        {
          packageName: '@haive/module-alpha',
          manifest: manifestOf('alpha'),
          routes: routesOf('alpha'),
        },
        {
          packageName: '@haive/module-beta',
          manifest: manifestOf('beta'),
          routes: routesOf('beta'),
        },
        {
          packageName: '@haive/module-gamma',
          manifest: manifestOf('gamma', { apiRequiresAdmin: true }),
          routes: routesOf('gamma'),
        },
      ],
      { db: counted },
    );
    app.route('/modules', moduleRoutes(loaded));
    app.route('/admin/task-types', adminTaskTypeRoutes);

    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'module-deactivation-api-test@test.local',
        emailBlindIndex: USER_EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
  });

  const clean = async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.type, TYPE));
    await db.delete(schema.modules);
    await db.delete(schema.stepCatalog);
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'module'));
  };

  beforeEach(async () => {
    h.role = 'admin';
    h.anonymous = false;
    h.stored = new Map();
    selects = 0;
    await clean();
    for (const id of ['alpha', 'alpha-two', 'beta', 'gamma']) await setModule(id);
  });

  afterAll(async () => {
    await clean();
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe('/m/<id>', () => {
    it('stops answering the moment the module is deactivated, and answers again once it is back', async () => {
      expect(await read('/m/alpha/x')).toMatchObject({ status: 200 });
      expect((await patchModule('alpha', false)).status).toBe(200);

      const unknown = await read('/m/ghost/x');
      expect(unknown.status).toBe(404);
      expect(await read('/m/alpha/x')).toEqual(unknown);
      expect(await read('/m/beta/x')).toMatchObject({ status: 200 });

      expect((await patchModule('alpha', true)).status).toBe(200);
      expect(await read('/m/alpha/x')).toMatchObject({ status: 200 });
    });

    it("leaves another module's responses as they were", async () => {
      const listOf = async (id: string) =>
        (JSON.parse((await read('/modules')).body) as { modules: { id: string }[] }).modules.find(
          (m) => m.id === id,
        );
      const capture = async () => ({
        route: await read('/m/beta/x'),
        settings: await read('/modules/beta/settings/global'),
        listed: await listOf('beta'),
      });
      const before = await capture();
      expect(before.route.status).toBe(200);
      expect(before.listed).toBeDefined();
      await patchModule('alpha', false);
      expect(await capture()).toEqual(before);
    });

    it('answers a user for a deactivated admin-only module as it answers an unknown one', async () => {
      h.role = 'user';
      expect((await read('/m/gamma/x')).status).toBe(403);
      await db
        .update(schema.modules)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.modules.moduleId, 'gamma'));
      expect(await read('/m/gamma/x')).toEqual(await read('/m/ghost/x'));
    });

    it('asks for a login before it reads the database', async () => {
      await db
        .update(schema.modules)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.modules.moduleId, 'alpha'));
      selects = 0;
      expect((await read('/m/beta/x')).status).toBe(200);
      expect(selects).toBeGreaterThan(0);

      h.anonymous = true;
      selects = 0;
      const active = await read('/m/beta/x');
      const off = await read('/m/alpha/x');
      expect(active.status).toBe(401);
      expect(off).toEqual(active);
      expect(selects).toBe(0);
    });
  });

  describe('GET /modules and settings', () => {
    beforeEach(async () => {
      await db
        .update(schema.modules)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.modules.moduleId, 'alpha'));
    });

    it.each(['admin', 'user'])('role %s: leaves the deactivated module out', async (role) => {
      h.role = role;
      const { modules } = JSON.parse((await read('/modules')).body) as {
        modules: { id: string }[];
      };
      expect(modules.map((m) => m.id)).toEqual(['beta', 'gamma']);
    });

    it('answers its settings as it answers an unknown module, and keeps the stored values', async () => {
      h.stored.set('config:module:alpha:global:limit', JSON.stringify('9'));
      const put = { values: { limit: '7' } };
      expect(await read('/modules/alpha/settings/global')).toEqual(
        await read('/modules/ghost/settings/global'),
      );
      const refused = await send('PUT', '/modules/alpha/settings/global', put);
      const unknown = await send('PUT', '/modules/ghost/settings/global', put);
      expect(refused.status).toBe(404);
      expect(await refused.text()).toBe(await unknown.text());
      expect(h.stored.get('config:module:alpha:global:limit')).toBe(JSON.stringify('9'));

      expect((await patchModule('alpha', true)).status).toBe(200);
      const back = JSON.parse((await read('/modules/alpha/settings/global')).body) as {
        values: { limit: string };
      };
      expect(back.values.limit).toBe('9');
    });

    it('serves an active module its settings', async () => {
      expect((await read('/modules/beta/settings/global')).status).toBe(200);
    });
  });

  describe('GET /modules/loaded', () => {
    it('still lists the module, with when it was deactivated', async () => {
      await patchModule('alpha', false);
      const stamp = (await stampOf('alpha'))!;
      const body = JSON.parse((await read('/modules/loaded')).body) as {
        intent: { moduleId: string; deactivatedAt: string | null }[];
        modules: { rows: { id: string; deactivatedAt: string | null }[] };
      };
      expect(
        Object.fromEntries(body.intent.map((r) => [r.moduleId, r.deactivatedAt])),
      ).toMatchObject({ alpha: stamp.toISOString(), beta: null });
      expect(
        Object.fromEntries(body.modules.rows.map((r) => [r.id, r.deactivatedAt])),
      ).toMatchObject({ alpha: stamp.toISOString(), beta: null });
    });
  });

  describe('GET /admin/task-types/catalog', () => {
    const catalog = async () => {
      const body = JSON.parse((await read('/admin/task-types/catalog')).body) as {
        steps: { stepId: string }[];
        groups: { id: string }[];
      };
      return { ...body, steps: body.steps.map((s) => s.stepId).sort() };
    };

    beforeEach(async () => {
      await db
        .insert(schema.stepCatalog)
        .values([
          catalogRow('md-core', 'core', 'build'),
          catalogRow('module.alpha.x', 'module:alpha', 'alpha-group'),
          catalogRow('module.alpha.y', 'module:alpha', 'alpha-group'),
          catalogRow('module.alpha-two.w', 'module:alpha-two', 'build'),
          catalogRow('module.beta.z', 'module:beta', 'beta-group'),
        ]);
    });

    it('lists every composable step while no module is deactivated', async () => {
      const body = await catalog();
      expect(body.steps).toEqual([
        'md-core',
        'module.alpha-two.w',
        'module.alpha.x',
        'module.alpha.y',
        'module.beta.z',
      ]);
      expect(body.groups.map((g) => g.id)).toEqual(
        expect.arrayContaining(['alpha-group', 'beta-group']),
      );
    });

    it('leaves out the steps of a deactivated module and no others, and its groups with them', async () => {
      await patchModule('alpha', false);
      const body = await catalog();
      expect(body.steps).toEqual(['md-core', 'module.alpha-two.w', 'module.beta.z']);
      expect(body.groups.map((g) => g.id)).not.toContain('alpha-group');
      expect(body.groups.map((g) => g.id)).toContain('beta-group');
      expect(await db.select().from(schema.stepCatalog)).toHaveLength(5);

      await patchModule('alpha', true);
      expect((await catalog()).steps).toHaveLength(5);
    });
  });

  describe('PATCH /modules/:id', () => {
    it('refuses a user and changes nothing', async () => {
      h.role = 'user';
      expect((await patchModule('alpha', false)).status).toBe(403);
      expect(await stampOf('alpha')).toBeNull();
      expect(await audits()).toHaveLength(0);
    });

    it.each([{}, { active: 'false' }, { active: false, extra: true }])(
      'refuses the body %j',
      async (body) => {
        expect((await send('PATCH', '/modules/alpha', body)).status).toBe(400);
        expect(await stampOf('alpha')).toBeNull();
      },
    );

    it('answers 404 for a module with no recorded row', async () => {
      const res = await patchModule('ghost', false);
      expect(res.status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });

    it.each(LIVE)('answers 409 and lists a %s task that uses the module', async (status) => {
      const t = await task({ status, title: 'Uses alpha' });
      const res = await patchModule('alpha', false);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: expect.any(String),
        code: 'module_tasks_open',
        tasks: [{ id: t.id, title: 'Uses alpha', status, ownerId: userId }],
      });
      expect(await stampOf('alpha')).toBeNull();
      expect(await audits()).toHaveLength(0);
      expect((await read('/m/alpha/x')).status).toBe(200);
    });

    it('stops refusing once the task that held it has ended', async () => {
      const t = await task({ runListSnapshot: ['module.alpha.x'] });
      expect((await patchModule('alpha', false)).status).toBe(409);
      await db.update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, t.id));
      expect((await patchModule('alpha', false)).status).toBe(200);
      expect(await stampOf('alpha')).toBeInstanceOf(Date);
    });

    it.each(ENDED)('deactivates when the only task that uses the module is %s', async (status) => {
      await task({ status });
      expect((await patchModule('alpha', false)).status).toBe(200);
      expect(await stampOf('alpha')).toBeInstanceOf(Date);
    });

    it('deactivates when the only task that uses the module is dead', async () => {
      await task({ deadAt: new Date(), deadReason: 'gone' });
      expect((await patchModule('alpha', false)).status).toBe(200);
    });

    it('is not held up by a task that only looks like it uses the module', async () => {
      await task({ runListSnapshot: ['module.beta.x', '01-worktree-setup'] });
      await task({ runListSnapshot: ['module.alpha-two.x'] });
      await task({ runListSnapshot: ['custom.alpha.x', 'alpha'] });
      await task({ runListSnapshot: [] });
      await task({ runListSnapshot: null });
      expect((await patchModule('alpha', false)).status).toBe(200);
    });

    it.each([
      ['{}', 'object'],
      ['"module.alpha.x"', 'string'],
      ['7', 'number'],
      ['true', 'boolean'],
      ['null', 'null'],
    ])('reads a snapshot of %s as using no module, without an error', async (json, jsonType) => {
      const t = await task();
      await rawSnapshot(t.id, json);
      const [stored] = (await db.execute(
        sql`SELECT jsonb_typeof(run_list_snapshot) AS type FROM tasks WHERE id = ${t.id}`,
      )) as unknown as { type: string }[];
      expect(stored?.type).toBe(jsonType);
      expect((await patchModule('alpha', false)).status).toBe(200);
    });

    it('lists at most 200 tasks', async () => {
      await db.insert(schema.tasks).values(
        Array.from({ length: 201 }, (_, i) => ({
          userId,
          type: TYPE,
          title: `Task ${i}`,
          status: 'running' as const,
          runListSnapshot: ['module.alpha.x'],
        })),
      );
      const res = await patchModule('alpha', false);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { tasks: unknown[] }).tasks).toHaveLength(200);
    });

    it('keeps the first stamp on a repeated deactivate, and clears it on activate', async () => {
      const first = (await (await patchModule('alpha', false)).json()) as {
        active: boolean;
        deactivatedAt: string;
      };
      const stamp = await stampOf('alpha');
      expect(first).toMatchObject({ moduleId: 'alpha', active: false });
      expect(first.deactivatedAt).toBe(stamp!.toISOString());

      await new Promise((r) => setTimeout(r, 20));
      const again = (await (await patchModule('alpha', false)).json()) as { deactivatedAt: string };
      expect(again.deactivatedAt).toBe(first.deactivatedAt);
      expect(await stampOf('alpha')).toEqual(stamp);

      const back = await patchModule('alpha', true);
      expect(await back.json()).toEqual({ moduleId: 'alpha', active: true, deactivatedAt: null });
      expect(await stampOf('alpha')).toBeNull();
      expect((await patchModule('alpha', true)).status).toBe(200);
    });

    it('keeps a stamp even while live tasks use the module', async () => {
      await patchModule('alpha', false);
      const stamp = await stampOf('alpha');
      await task();
      expect((await patchModule('alpha', false)).status).toBe(200);
      expect(await stampOf('alpha')).toEqual(stamp);
    });

    it('writes one audit row per accepted request, none per refusal', async () => {
      await task();
      await patchModule('alpha', false);
      expect(await audits()).toHaveLength(0);
      await db.delete(schema.tasks).where(eq(schema.tasks.type, TYPE));
      await patchModule('alpha', false);
      await patchModule('alpha', true);
      const rows = (await audits()).sort((a, b) => a.action.localeCompare(b.action));
      expect(
        rows.map((r) => [r.action, r.targetType, r.targetId, r.actorUserId, r.metadata]),
      ).toEqual([
        ['module.activate', 'module', null, ACTOR, { moduleId: 'alpha' }],
        ['module.deactivate', 'module', null, ACTOR, { moduleId: 'alpha' }],
      ]);
    });

    it('touches no task type definition and no other module', async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: TYPE,
        displayName: 'Module type',
        runListStrategy: 'static',
        stepIds: ['module.alpha.x'],
        source: 'module:alpha',
      });
      const defs = () =>
        db
          .select()
          .from(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, TYPE));
      const before = await defs();
      const beta = await db
        .select()
        .from(schema.modules)
        .where(eq(schema.modules.moduleId, 'beta'));
      await patchModule('alpha', false);
      await patchModule('alpha', true);
      expect(await defs()).toEqual(before);
      expect(
        await db.select().from(schema.modules).where(eq(schema.modules.moduleId, 'beta')),
      ).toEqual(beta);
    });

    it('waits for another transaction that holds the module row, even when it has nothing to write', async () => {
      await patchModule('alpha', false);
      let raced: string | undefined;
      let pending!: Promise<Response>;
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.modules)
          .where(eq(schema.modules.moduleId, 'alpha'))
          .for('update');
        pending = Promise.resolve(patchModule('alpha', false));
        raced = await Promise.race([
          pending.then(() => 'done'),
          new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 400)),
        ]);
      });
      expect(raced).toBe('blocked');
      expect((await pending).status).toBe(200);
    });
  });
});
