import { eq, inArray, sql } from 'drizzle-orm';
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
  flags: new Map<string, boolean>(),
  kills: [] as string[],
  bestEffortKills: [] as string[],
  killable: '',
  onKill: undefined as ((taskId: string) => Promise<void>) | undefined,
  eventFails: false,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/routes/tasks/_helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/routes/tasks/_helpers.js')>();
  return {
    ...original,
    appendTaskEvent: async (...args: Parameters<typeof original.appendTaskEvent>) => {
      if (h.eventFails) throw new Error('event refused');
      return original.appendTaskEvent(...args);
    },
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({
  killTaskSandboxes: async (taskId: string) => {
    h.bestEffortKills.push(taskId);
    return 0;
  },
  killTaskSandboxesOrThrow: async (taskId: string) => {
    h.kills.push(taskId);
    await h.onKill?.(taskId);
    return taskId === h.killable ? 1 : 0;
  },
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ get: async () => null }) }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
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
    get: async (key: string) => h.stored.get(key) ?? null,
    getFresh: async (key: string) => h.stored.get(key) ?? null,
    set: async (key: string, value: string) => {
      h.stored.set(key, value);
    },
    setIfAbsent: async () => undefined,
    getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
  },
}));

import { Hono } from 'hono';
import { CONFIG_KEYS } from '@haive/shared';
import {
  MODULE_DEPENDENTS_CAP,
  moduleManifestSchema,
  type ComposableStepEntry,
} from '@haive/shared/modularity';
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import { mountModules, moduleRoutes } from '../src/modules/loader.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { adminTaskTypeRoutes, taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const USER_EMAIL_INDEX = 'module-deactivation-api-test-user';
const TYPE = 'mod-deact-test';
const MODULE_TYPE = 'alpha__t';
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
const patchUrgent = (id: string) =>
  send('PATCH', `/modules/${id}`, { active: false, mode: 'urgent' });
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
  const taskAudits = () =>
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'task'));

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
    app.route('/task-types', taskTypeRoutes);
    app.route('/tasks', taskRoutes);

    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        id: ACTOR,
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
    await db.delete(schema.tasks).where(inArray(schema.tasks.type, [TYPE, MODULE_TYPE]));
    await db.delete(schema.modules);
    await db.delete(schema.stepCatalog);
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, [TYPE, MODULE_TYPE]));
    await db
      .delete(schema.auditEvents)
      .where(inArray(schema.auditEvents.targetType, ['module', 'task']));
  };

  beforeEach(async () => {
    h.role = 'admin';
    h.anonymous = false;
    h.stored = new Map();
    h.flags = new Map();
    h.kills = [];
    h.bestEffortKills = [];
    h.killable = '';
    h.onKill = undefined;
    h.eventFails = false;
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

  describe('GET /modules/loaded and the teardown record', () => {
    it('carries when the teardown ran, on the record and on the row', async () => {
      const down = new Date('2026-10-14T09:30:00.000Z');
      await patchModule('alpha', false);
      await db
        .update(schema.modules)
        .set({ tornDownAt: down })
        .where(eq(schema.modules.moduleId, 'alpha'));
      const body = JSON.parse((await read('/modules/loaded')).body) as {
        intent: { moduleId: string; tornDownAt: string | null }[];
        modules: { rows: { id: string; tornDownAt: string | null }[] };
      };
      expect(Object.fromEntries(body.intent.map((r) => [r.moduleId, r.tornDownAt]))).toMatchObject({
        alpha: down.toISOString(),
        beta: null,
      });
      expect(Object.fromEntries(body.modules.rows.map((r) => [r.id, r.tornDownAt]))).toMatchObject({
        alpha: down.toISOString(),
        beta: null,
      });
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

    it.each([
      {},
      { active: 'false' },
      { active: false, extra: true },
      { active: true, mode: 'urgent' },
      { active: false, mode: 'graceful' },
      { active: false, mode: 'urgent', extra: true },
    ])('refuses the body %j', async (body) => {
      expect((await send('PATCH', '/modules/alpha', body)).status).toBe(400);
      expect(await stampOf('alpha')).toBeNull();
      expect(h.kills).toEqual([]);
    });

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
        tasks: [{ id: t.id, title: 'Uses alpha', status, ownerId: userId, currentStepId: null }],
        capped: false,
      });
      expect(await stampOf('alpha')).toBeNull();
      expect(await audits()).toHaveLength(0);
      expect((await read('/m/alpha/x')).status).toBe(200);
    });

    it('names the step each listed task is on', async () => {
      await task({ currentStepId: 'module.alpha.x' });
      const res = await patchModule('alpha', false);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { tasks: unknown[] }).tasks).toEqual([
        expect.objectContaining({ currentStepId: 'module.alpha.x' }),
      ]);
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

    it('answers 409 for a live task of a type the module seeded, though its steps are all core', async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: TYPE,
        displayName: 'Module type',
        runListStrategy: 'static',
        stepIds: ['01-worktree-setup'],
        source: 'module:alpha',
      });
      const t = await task({ title: 'Module-owned', runListSnapshot: ['01-worktree-setup'] });
      const res = await patchModule('alpha', false);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { tasks: { id: string }[] }).tasks).toEqual([
        expect.objectContaining({ id: t.id, title: 'Module-owned' }),
      ]);
      expect(await stampOf('alpha')).toBeNull();
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

    it('lists at most MODULE_DEPENDENTS_CAP tasks', async () => {
      await db.insert(schema.tasks).values(
        Array.from({ length: MODULE_DEPENDENTS_CAP + 1 }, (_, i) => ({
          userId,
          type: TYPE,
          title: `Task ${i}`,
          status: 'running' as const,
          runListSnapshot: ['module.alpha.x'],
        })),
      );
      const res = await patchModule('alpha', false);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { tasks: unknown[]; capped: boolean };
      expect(body.tasks).toHaveLength(MODULE_DEPENDENTS_CAP);
      expect(body.capped).toBe(true);

      await db.delete(schema.tasks).where(eq(schema.tasks.title, `Task ${MODULE_DEPENDENTS_CAP}`));
      const exact = (await (await patchModule('alpha', false)).json()) as {
        tasks: unknown[];
        capped: boolean;
      };
      expect(exact.tasks).toHaveLength(MODULE_DEPENDENTS_CAP);
      expect(exact.capped).toBe(false);
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

    it('moves updated_at forward on a deactivate, an urgent deactivate and an activate, and leaves it on a repeated deactivate', async () => {
      const long = new Date('2026-01-01T00:00:00.000Z');
      const updatedAt = async (moduleId: string) =>
        (
          await db
            .select({ at: schema.modules.updatedAt })
            .from(schema.modules)
            .where(eq(schema.modules.moduleId, moduleId))
        )[0]!.at;
      const age = () =>
        db
          .update(schema.modules)
          .set({ updatedAt: long })
          .where(inArray(schema.modules.moduleId, ['alpha', 'beta']));
      await age();

      expect((await patchModule('alpha', false)).status).toBe(200);
      expect((await updatedAt('alpha')).getTime()).toBeGreaterThan(long.getTime());
      expect(await updatedAt('beta')).toEqual(long);

      await age();
      expect((await patchModule('alpha', false)).status).toBe(200);
      expect(await updatedAt('alpha')).toEqual(long);

      expect((await patchModule('alpha', true)).status).toBe(200);
      expect((await updatedAt('alpha')).getTime()).toBeGreaterThan(long.getTime());
      expect(await updatedAt('beta')).toEqual(long);

      expect((await patchUrgent('beta')).status).toBe(200);
      expect((await updatedAt('beta')).getTime()).toBeGreaterThan(long.getTime());

      await age();
      expect((await patchUrgent('beta')).status).toBe(200);
      expect(await updatedAt('beta')).toEqual(long);
    });

    it('clears the teardown record on activate and keeps it on a repeated deactivate', async () => {
      const down = new Date('2026-10-14T09:30:00.000Z');
      const record = async (moduleId: string) =>
        (
          await db
            .select({ at: schema.modules.tornDownAt })
            .from(schema.modules)
            .where(eq(schema.modules.moduleId, moduleId))
        )[0]?.at;
      await patchModule('alpha', false);
      await patchModule('alpha-two', false);
      await db
        .update(schema.modules)
        .set({ tornDownAt: down })
        .where(inArray(schema.modules.moduleId, ['alpha', 'alpha-two']));

      expect((await patchModule('alpha', false)).status).toBe(200);
      expect(await record('alpha')).toEqual(down);

      expect((await patchModule('alpha', true)).status).toBe(200);
      expect(await record('alpha')).toBeNull();
      expect(await record('alpha-two')).toEqual(down);

      await patchModule('alpha', false);
      expect(await record('alpha')).toBeNull();
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

  describe('PATCH /modules/:id with mode urgent', () => {
    type Row = Awaited<ReturnType<typeof task>>;
    type Body = {
      moduleId: string;
      active: boolean;
      deactivatedAt: string;
      stopped: {
        id: string;
        title: string;
        killed: number;
        cancelled: number;
        stopped: number;
        failedAt: string | null;
        eventError?: string;
        killError?: string;
      }[];
      left: { id: string; title: string; status: string; currentStepId: string | null }[];
      failed: { id: string; title: string; error: string }[];
      capped: boolean;
    };
    const step = async (taskId: string, stepId: string, status: 'waiting_cli' | 'waiting_form') => {
      const [row] = await db
        .insert(schema.taskSteps)
        .values({ taskId, stepId, stepIndex: 1, round: 0, title: stepId, status })
        .returning();
      return row!;
    };
    const working = async (over: Partial<typeof schema.tasks.$inferInsert>, stepId: string) => {
      const made = await task({ ...over, currentStepId: stepId });
      await db.insert(schema.cliInvocations).values({
        taskId: made.id,
        taskStepId: (await step(made.id, stepId, 'waiting_cli')).id,
        mode: 'cli',
        prompt: 'p',
        startedAt: new Date(),
      });
      return made;
    };
    const observe = (ids: string[]) =>
      Promise.all(
        ids.map(async (id) => ({
          task: (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0],
          steps: await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, id)),
          runs: await db
            .select()
            .from(schema.cliInvocations)
            .where(eq(schema.cliInvocations.taskId, id)),
          events: await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, id)),
        })),
      );
    const stoppedEvents = () =>
      db.select().from(schema.taskEvents).where(eq(schema.taskEvents.eventType, 'task.stopped'));
    const completedAtOf = async (id: string) =>
      (await observe([id]))[0]!.task!.completedAt!.toISOString();
    const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    const sorted = (ids: string[]) => [...ids].sort();

    let a: Row, b: Row, c: Row, d: Row, e: Row, f: Row, g: Row;

    beforeEach(async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: MODULE_TYPE,
        displayName: 'Alpha type',
        runListStrategy: 'static',
        stepIds: ['07-x'],
        source: 'module:alpha',
      });
      a = await working({ title: 'A', runListSnapshot: ['module.alpha.x'] }, 'module.alpha.x');
      b = await working({ title: 'B', runListSnapshot: ['07-x', 'module.alpha.y'] }, '07-x');
      c = await task({
        title: 'C',
        status: 'waiting_user',
        currentStepId: 'module.alpha.x',
        runListSnapshot: ['module.alpha.x'],
      });
      await step(c.id, 'module.alpha.x', 'waiting_form');
      d = await working({ title: 'D', type: MODULE_TYPE, runListSnapshot: ['07-x'] }, '07-x');
      e = await task({
        title: 'E',
        status: 'completed',
        currentStepId: 'module.alpha.x',
        runListSnapshot: ['module.alpha.x'],
      });
      f = await working(
        { title: 'F', deadAt: new Date(), deadReason: 'gone', runListSnapshot: ['module.alpha.x'] },
        'module.alpha.x',
      );
      g = await working({ title: 'G', runListSnapshot: ['module.beta.x'] }, 'module.beta.x');
      h.killable = a.id;
    });

    it('stops the task that is in a step of the module and lists the others it left', async () => {
      const res = await patchUrgent('alpha');
      expect(res.status).toBe(200);
      const stamp = (await stampOf('alpha'))!;
      expect(stamp).toBeInstanceOf(Date);
      const body = (await res.json()) as Body;
      expect(body).toMatchObject({
        moduleId: 'alpha',
        active: false,
        deactivatedAt: stamp.toISOString(),
        failed: [],
        capped: false,
      });
      expect(body.stopped).toEqual([
        {
          id: a.id,
          title: 'A',
          killed: 1,
          cancelled: 1,
          stopped: 1,
          failedAt: await completedAtOf(a.id),
        },
      ]);
      expect(body.left).toHaveLength(3);
      expect(body.left).toEqual(
        expect.arrayContaining([
          { id: b.id, title: 'B', status: 'running', currentStepId: '07-x' },
          { id: c.id, title: 'C', status: 'waiting_user', currentStepId: 'module.alpha.x' },
          { id: d.id, title: 'D', status: 'running', currentStepId: '07-x' },
        ]),
      );
    });

    it('ends the run and the step of the task it stopped, tells its owner, and touches no other task', async () => {
      const others = [b, c, d, e, f, g].map((t) => t.id);
      const before = await observe(others);
      expect((await patchUrgent('alpha')).status).toBe(200);
      expect(await observe(others)).toEqual(before);

      const [after] = await observe([a.id]);
      expect(after!.task).toMatchObject({
        status: 'failed',
        errorMessage: 'Stopped by an administrator',
      });
      expect(after!.task!.completedAt).toBeInstanceOf(Date);
      expect(after!.runs).toMatchObject([
        { exitCode: 137, errorMessage: 'CLI cancelled by an administrator' },
      ]);
      expect(after!.runs[0]!.endedAt).toBeInstanceOf(Date);
      expect(after!.runs[0]!.supersededAt).toBeInstanceOf(Date);
      expect(after!.steps).toMatchObject([
        { status: 'failed', errorMessage: 'Stopped by an administrator' },
      ]);
      expect(after!.events.map((ev) => [ev.eventType, ev.payload])).toEqual([
        [
          'task.stopped',
          {
            by: ACTOR,
            byAdmin: true,
            reason: 'module_deactivated',
            moduleId: 'alpha',
            killed: 1,
            cancelled: 1,
            stopped: 1,
            failedAt: after!.task!.completedAt!.toISOString(),
          },
        ],
      ]);
      expect(
        (await taskAudits()).map((r) => [r.action, r.targetId, r.actorUserId, r.metadata]),
      ).toEqual([['task.admin_stop', a.id, ACTOR, { ownerUserId: userId, moduleId: 'alpha' }]]);
      expect(sorted(h.kills)).toEqual(sorted([a.id, c.id]));
    });

    it('records on the entry and in the event of a stopped task the instant it failed the task: the stamp the task carries', async () => {
      const body = (await (await patchUrgent('alpha')).json()) as Body;
      const [after] = await observe([a.id]);
      const failedAt = after!.task!.completedAt!.toISOString();
      expect(body.stopped.map((s) => s.failedAt)).toEqual([failedAt]);
      expect(after!.events.map((ev) => (ev.payload as { failedAt?: unknown }).failedAt)).toEqual([
        failedAt,
      ]);
    });

    it('records no instant for a task that failed on its own before its stop reached it', async () => {
      const own = await working(
        {
          title: 'Failed itself',
          runListSnapshot: ['module.alpha.x'],
          updatedAt: new Date('2020-01-01T00:00:00.000Z'),
        },
        'module.alpha.x',
      );
      const failedOn = new Date('2026-10-15T09:00:00.000Z');
      h.onKill = async (taskId) => {
        if (taskId !== a.id) return;
        await db
          .update(schema.tasks)
          .set({ status: 'failed', errorMessage: 'It broke', completedAt: failedOn })
          .where(eq(schema.tasks.id, own.id));
      };
      const body = (await (await patchUrgent('alpha')).json()) as Body;
      expect(body.stopped.filter((s) => s.id === own.id)).toEqual([
        { id: own.id, title: 'Failed itself', killed: 0, cancelled: 1, stopped: 1, failedAt: null },
      ]);
      const [after] = await observe([own.id]);
      expect(after!.task).toMatchObject({
        status: 'failed',
        errorMessage: 'It broke',
        completedAt: failedOn,
      });
      expect(after!.events.map((ev) => ev.payload)).toMatchObject([
        { reason: 'module_deactivated', failedAt: null },
      ]);
    });

    describe('on the task page payload', () => {
      const stopOf = async (id: string) => {
        const res = await app.request(`/tasks/${id}`);
        expect(res.status).toBe(200);
        return ((await res.json()) as { stop: unknown }).stop;
      };
      const failedAgain = (id: string) =>
        db
          .update(schema.tasks)
          .set({
            status: 'failed',
            errorMessage: 'It broke',
            completedAt: new Date(Date.now() + 1000),
          })
          .where(eq(schema.tasks.id, id));

      it('names the module that was turned off on the task it stopped, and on no other', async () => {
        expect(await stopOf(a.id)).toBeNull();
        await patchUrgent('alpha');
        expect(await stopOf(a.id)).toEqual({ reason: 'module_deactivated', moduleId: 'alpha' });
        for (const other of [b, c, d, e, f, g]) expect(await stopOf(other.id)).toBeNull();
      });

      it('names it no longer once the task is retried, nor when it fails again for another reason', async () => {
        await patchUrgent('alpha');
        await db
          .update(schema.tasks)
          .set({ status: 'running', errorMessage: null, completedAt: null })
          .where(eq(schema.tasks.id, a.id));
        expect(await stopOf(a.id)).toBeNull();
        await failedAgain(a.id);
        expect(await stopOf(a.id)).toBeNull();
      });

      it('names it no longer when the owner retried while its sandboxes were being killed and the retry failed at once', async () => {
        const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
        h.onKill = async (taskId) => {
          if (taskId !== a.id) return;
          await db
            .update(schema.tasks)
            .set({ status: 'running', errorMessage: null, completedAt: null })
            .where(eq(schema.tasks.id, a.id));
          await wait();
          await db
            .update(schema.tasks)
            .set({ status: 'failed', errorMessage: 'It broke', completedAt: new Date() })
            .where(eq(schema.tasks.id, a.id));
          await wait();
        };
        await patchUrgent('alpha');
        expect(await stopOf(a.id)).toBeNull();
      });

      it('reports the latest stop, whatever its reason', async () => {
        await patchUrgent('alpha');
        await db.insert(schema.taskEvents).values({
          taskId: a.id,
          eventType: 'task.stopped',
          payload: { by: ACTOR, byAdmin: true, reason: 'maintenance' },
        });
        expect(await stopOf(a.id)).toEqual({ reason: 'maintenance', moduleId: null });
      });
    });

    it('audits the deactivation with its mode and how many tasks it stopped', async () => {
      await patchUrgent('alpha');
      expect(
        (await audits()).map((r) => [
          r.action,
          r.targetType,
          r.targetId,
          r.actorUserId,
          r.metadata,
        ]),
      ).toEqual([
        [
          'module.deactivate',
          'module',
          null,
          ACTOR,
          { moduleId: 'alpha', mode: 'urgent', stopped: 1 },
        ],
      ]);
    });

    it('commits the stamp before it stops the first task', async () => {
      const seen: (Date | null | undefined)[] = [];
      h.onKill = async () => {
        seen.push(await stampOf('alpha'));
      };
      await patchUrgent('alpha');
      expect(seen).toHaveLength(2);
      expect(seen.every((at) => at instanceof Date)).toBe(true);
    });

    it('repeated: keeps the first stamp, stops nothing and writes no event where nothing stopped', async () => {
      const first = (await (await patchUrgent('alpha')).json()) as Body;
      const stamp = await stampOf('alpha');
      await new Promise((r) => setTimeout(r, 20));
      expect(await stoppedEvents()).toHaveLength(1);

      const again = (await (await patchUrgent('alpha')).json()) as Body;
      expect(again.deactivatedAt).toBe(first.deactivatedAt);
      expect(await stampOf('alpha')).toEqual(stamp);
      expect(again.stopped).toEqual([]);
      expect(idsOf(again.left)).toEqual(sorted([b.id, c.id, d.id]));
      expect(await stoppedEvents()).toHaveLength(1);
      expect(await taskAudits()).toHaveLength(1);
      expect((await audits()).map((r) => r.metadata)).toEqual([
        { moduleId: 'alpha', mode: 'urgent', stopped: 1 },
        { moduleId: 'alpha', mode: 'urgent', stopped: 0 },
      ]);
    });

    it('repeated: stops a task that has since started a step of the module', async () => {
      await patchUrgent('alpha');
      const late = await working(
        { title: 'Late', runListSnapshot: ['module.alpha.x'] },
        'module.alpha.x',
      );
      h.killable = late.id;
      const again = (await (await patchUrgent('alpha')).json()) as Body;
      expect(again.stopped).toEqual([
        {
          id: late.id,
          title: 'Late',
          killed: 1,
          cancelled: 1,
          stopped: 1,
          failedAt: await completedAtOf(late.id),
        },
      ]);
      expect(await stoppedEvents()).toHaveLength(2);
    });

    it.each(['module.beta.x', 'module.alpha-two.x'])(
      'leaves a task that is in a step of %s, though its next step is a step of alpha',
      async (current) => {
        const other = await working(
          { title: 'Other', runListSnapshot: [current, 'module.alpha.y'] },
          current,
        );
        const body = (await (await patchUrgent('alpha')).json()) as Body;
        expect(idsOf(body.left)).toContain(other.id);
        expect(idsOf(body.stopped)).not.toContain(other.id);
        expect(h.kills).not.toContain(other.id);
      },
    );

    it('collects the tasks whose stop transaction throws, leaves each as it was, kills nothing for them and still tries each one', async () => {
      const refusing = () =>
        working({ title: 'Refused stop', runListSnapshot: ['module.alpha.x'] }, 'module.alpha.x');
      const refused = [await refusing(), await refusing()];
      const ids = refused.map((t) => t.id);
      const before = await observe(ids);
      try {
        await db.execute(
          sql`CREATE OR REPLACE FUNCTION module_deactivation_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'refused by the test'; END $body$`,
        );
        await db.execute(
          sql`CREATE TRIGGER module_deactivation_test_refuse BEFORE UPDATE ON tasks FOR EACH ROW WHEN (NEW.title = 'Refused stop' AND NEW.status = 'failed') EXECUTE FUNCTION module_deactivation_test_refuse()`,
        );
        const res = await patchUrgent('alpha');
        expect(res.status).toBe(200);
        const body = (await res.json()) as Body;
        expect(idsOf(body.failed)).toEqual(sorted(ids));
        expect(
          body.failed.every(({ title, error }) => title === 'Refused stop' && error !== ''),
        ).toBe(true);
        expect(body.stopped).toEqual([
          {
            id: a.id,
            title: 'A',
            killed: 1,
            cancelled: 1,
            stopped: 1,
            failedAt: await completedAtOf(a.id),
          },
        ]);
        expect(idsOf(body.left)).toEqual(sorted([b.id, c.id, d.id]));
        expect(await observe(ids)).toEqual(before);
        expect(sorted(h.kills)).toEqual(sorted([a.id, c.id]));
        expect(await stampOf('alpha')).toBeInstanceOf(Date);
        expect(await stoppedEvents()).toHaveLength(1);
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS module_deactivation_test_refuse ON tasks`);
        await db.execute(sql`DROP FUNCTION IF EXISTS module_deactivation_test_refuse()`);
      }
    });

    it('kills through the strict variant and never the best-effort one', async () => {
      expect((await patchUrgent('alpha')).status).toBe(200);
      expect(sorted(h.kills)).toEqual(sorted([a.id, c.id]));
      expect(h.bestEffortKills).toEqual([]);
    });

    it('keeps a task whose stop committed under stopped when its sandbox kill throws, and says why', async () => {
      h.onKill = async (taskId) => {
        throw new Error(`refused ${taskId}`);
      };
      const res = await patchUrgent('alpha');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body.failed).toEqual([]);
      expect(body.stopped).toEqual([
        {
          id: a.id,
          title: 'A',
          killed: 0,
          cancelled: 1,
          stopped: 1,
          failedAt: await completedAtOf(a.id),
          killError: `refused ${a.id}`,
        },
      ]);
      expect(idsOf(body.left)).toEqual(sorted([b.id, c.id, d.id]));
      expect(sorted(h.kills)).toEqual(sorted([a.id, c.id]));
      expect(await stampOf('alpha')).toBeInstanceOf(Date);
      const [after] = await observe([a.id]);
      expect(after!.task).toMatchObject({
        status: 'failed',
        errorMessage: 'Stopped by an administrator',
      });
      expect(after!.events.map((ev) => [ev.eventType, ev.payload])).toEqual([
        [
          'task.stopped',
          {
            by: ACTOR,
            byAdmin: true,
            reason: 'module_deactivated',
            moduleId: 'alpha',
            killed: 0,
            cancelled: 1,
            stopped: 1,
            failedAt: after!.task!.completedAt!.toISOString(),
          },
        ],
      ]);
      expect((await audits()).map((r) => r.metadata)).toEqual([
        { moduleId: 'alpha', mode: 'urgent', stopped: 1 },
      ]);
      expect((await taskAudits()).map((r) => [r.action, r.targetId])).toEqual([
        ['task.admin_stop', a.id],
      ]);
    });

    it('keeps a task whose stop committed under stopped when the write of its event throws, and says why', async () => {
      h.eventFails = true;
      const res = await patchUrgent('alpha');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body.failed).toEqual([]);
      expect(body.stopped).toEqual([
        {
          id: a.id,
          title: 'A',
          killed: 1,
          cancelled: 1,
          stopped: 1,
          failedAt: await completedAtOf(a.id),
          eventError: 'event refused',
        },
      ]);
      const [after] = await observe([a.id]);
      expect(after!.task).toMatchObject({
        status: 'failed',
        errorMessage: 'Stopped by an administrator',
      });
      expect(after!.events).toEqual([]);
      expect((await audits()).map((r) => r.metadata)).toEqual([
        { moduleId: 'alpha', mode: 'urgent', stopped: 1 },
      ]);
      expect((await taskAudits()).map((r) => [r.action, r.targetId])).toEqual([
        ['task.admin_stop', a.id],
      ]);
    });

    it('deactivates a module nothing depends on and reports nothing', async () => {
      const res = await patchUrgent('gamma');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body).toMatchObject({
        moduleId: 'gamma',
        active: false,
        stopped: [],
        failed: [],
        capped: false,
      });
      expect(body.left).toEqual([]);
      expect(await stampOf('gamma')).toBeInstanceOf(Date);
      expect(h.kills).toEqual([]);
      expect((await audits()).map((r) => r.metadata)).toEqual([
        { moduleId: 'gamma', mode: 'urgent', stopped: 0 },
      ]);
    });

    it('answers 404 for a module with no recorded row, and stops nothing', async () => {
      expect((await patchUrgent('ghost')).status).toBe(404);
      expect(await audits()).toHaveLength(0);
      expect(h.kills).toEqual([]);
    });

    it('refuses a user and changes nothing', async () => {
      h.role = 'user';
      expect((await patchUrgent('alpha')).status).toBe(403);
      expect(await stampOf('alpha')).toBeNull();
      expect(await audits()).toHaveLength(0);
      expect(h.kills).toEqual([]);
    });

    describe('past the 200 tasks it lists', () => {
      beforeEach(async () => {
        await db
          .update(schema.tasks)
          .set({ status: 'completed' })
          .where(eq(schema.tasks.userId, userId));
      });

      it.each([
        { elsewhere: 200, older: 3, capped: true },
        { elsewhere: 200, older: 1, capped: true },
        { elsewhere: 199, older: 1, capped: false },
      ])(
        'with $elsewhere other tasks and $older older ones in a step of the module: stops every older one, capped is $capped',
        async ({ elsewhere, older, capped }) => {
          await db.insert(schema.tasks).values(
            Array.from({ length: elsewhere }, (_, i) => ({
              userId,
              type: TYPE,
              title: `Elsewhere ${i}`,
              status: 'running' as const,
              currentStepId: '07-x',
              runListSnapshot: ['module.alpha.x'],
            })),
          );
          const inStep: Row[] = [];
          for (let i = 0; i < older; i += 1) {
            inStep.push(
              await working(
                {
                  title: `In step ${i}`,
                  updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
                  runListSnapshot: ['module.alpha.x'],
                },
                'module.alpha.x',
              ),
            );
          }
          const ids = inStep.map((t) => t.id);

          const body = (await (await patchUrgent('alpha')).json()) as Body;
          expect(idsOf(body.stopped)).toEqual(sorted(ids));
          expect(body.failed).toEqual([]);
          expect(body.capped).toBe(capped);
          expect(body.left).toHaveLength(elsewhere);
          expect(idsOf(body.left).filter((id) => ids.includes(id))).toEqual([]);
          expect(sorted(h.kills)).toEqual(sorted(ids));
          expect(await stoppedEvents()).toHaveLength(older);

          const rows = await db
            .select({ id: schema.tasks.id, status: schema.tasks.status })
            .from(schema.tasks)
            .where(inArray(schema.tasks.status, ['running', 'failed']));
          expect(rows.filter((r) => r.status === 'running')).toHaveLength(elsewhere);
          expect(idsOf(rows.filter((r) => r.status === 'failed'))).toEqual(sorted(ids));
        },
      );
    });
  });

  describe('a task type that uses a deactivated module', () => {
    const insertType = (over: Partial<typeof schema.taskTypeDefinitions.$inferInsert> = {}) =>
      db.insert(schema.taskTypeDefinitions).values({
        slug: TYPE,
        displayName: 'Uses alpha',
        runListStrategy: 'static',
        stepIds: ['md-core', 'module.alpha.x'],
        source: 'admin',
        requiresRepository: false,
        ...over,
      });
    const postTask = () =>
      send('POST', '/tasks', { type: TYPE, title: 'Uses alpha', description: 'do it' });
    const typeTasks = () => db.select().from(schema.tasks).where(eq(schema.tasks.type, TYPE));
    const json = async <T>(path: string) => JSON.parse((await read(path)).body) as T;
    const published = async () =>
      (
        await json<{ taskTypes: { slug: string; available: boolean; reason?: string }[] }>(
          '/task-types',
        )
      ).taskTypes.find((t) => t.slug === TYPE);
    const detail = async () =>
      (await json<{ availability: unknown }>(`/admin/task-types/${TYPE}`)).availability;
    const listed = async () =>
      (
        await json<{ taskTypes: { slug: string; availability: unknown }[] }>('/admin/task-types')
      ).taskTypes.find((t) => t.slug === TYPE)?.availability;
    const settled = (pending: Promise<Response>) =>
      Promise.race([
        pending.then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 400)),
      ]);
    const unavailable = {
      available: false,
      reason: 'module-deactivated',
      modules: [{ id: 'alpha', name: 'alpha' }],
    };

    beforeEach(async () => {
      h.flags.set(CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED, true);
      h.flags.set(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, true);
      await db
        .insert(schema.stepCatalog)
        .values([
          catalogRow('md-core', 'core', 'build'),
          catalogRow('module.alpha.x', 'module:alpha', 'alpha-group'),
          catalogRow('module.beta.z', 'module:beta', 'beta-group'),
        ]);
    });

    it.each([
      ['an admin type that names one of its steps', { stepIds: ['md-core', 'module.alpha.x'] }],
      ['a type it seeded', { source: 'module:alpha', stepIds: ['md-core'] }],
    ])(
      'creates no task from %s while the module is deactivated, and says why',
      async (_label, over) => {
        await insertType(over);
        expect((await postTask()).status).toBe(201);
        await db.delete(schema.tasks).where(eq(schema.tasks.type, TYPE));

        expect((await patchModule('alpha', false)).status).toBe(200);
        const refused = await postTask();
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual({
          error: expect.stringContaining('alpha'),
          code: 'module-deactivated',
        });
        expect(await typeTasks()).toHaveLength(0);

        expect((await patchModule('alpha', true)).status).toBe(200);
        expect((await postTask()).status).toBe(201);
        expect(await typeTasks()).toHaveLength(1);
      },
    );

    it('lists the type unavailable with the reason, and the module on the admin routes, until the module is back', async () => {
      await insertType();
      expect(await published()).toMatchObject({ available: true });
      expect(await detail()).toEqual({ available: true });
      expect(await listed()).toEqual({ available: true });

      await patchModule('alpha', false);
      expect(await published()).toMatchObject({ available: false, reason: 'module-deactivated' });
      expect(await detail()).toEqual(unavailable);
      expect(await listed()).toEqual(unavailable);

      await patchModule('alpha', true);
      expect(await published()).toMatchObject({ available: true });
      expect((await published())?.reason).toBeUndefined();
      expect(await detail()).toEqual({ available: true });
      expect(await listed()).toEqual({ available: true });
    });

    it("leaves a type that uses only another module's steps available and creatable", async () => {
      await insertType({ stepIds: ['md-core', 'module.beta.z'] });
      await patchModule('alpha', false);
      expect(await published()).toMatchObject({ available: true });
      expect(await detail()).toEqual({ available: true });
      expect((await postTask()).status).toBe(201);
    });

    it('still accepts a definition that names the module, on create and on edit', async () => {
      await patchModule('alpha', false);
      const create = await send('POST', '/admin/task-types', {
        slug: TYPE,
        displayName: 'Uses alpha',
        stepIds: ['md-core', 'module.alpha.x'],
        requiresRepository: false,
      });
      expect(create.status).toBe(201);
      const edit = await send('PATCH', `/admin/task-types/${TYPE}`, {
        displayName: 'Renamed',
        stepIds: ['module.alpha.x'],
      });
      expect(edit.status).toBe(200);
      expect(await detail()).toEqual(unavailable);
    });

    it('holds the module row until the create commits, so a deactivate that arrives meanwhile waits and then finds the new task', async () => {
      await insertType();
      let pending!: Promise<Response>;
      let raced: string | undefined;
      let madeId = '';
      await db.transaction(async (tx) => {
        const { runListSnapshot } = await definitionForCreate(tx, TYPE, { generic: true });
        const [made] = await tx
          .insert(schema.tasks)
          .values({ userId, type: TYPE, title: 'Mid-create', status: 'created', runListSnapshot })
          .returning();
        madeId = made!.id;
        pending = Promise.resolve(patchModule('alpha', false));
        raced = await settled(pending);
      });
      expect(raced).toBe('blocked');
      const res = await pending;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'module_tasks_open',
        tasks: [{ id: madeId, title: 'Mid-create' }],
      });
      expect(await stampOf('alpha')).toBeNull();
    });

    it('holds an urgent deactivate until the create commits, then lists the new task as left', async () => {
      await insertType();
      let pending!: Promise<Response>;
      let raced: string | undefined;
      let madeId = '';
      await db.transaction(async (tx) => {
        const { runListSnapshot } = await definitionForCreate(tx, TYPE, { generic: true });
        const [made] = await tx
          .insert(schema.tasks)
          .values({ userId, type: TYPE, title: 'Mid-create', status: 'created', runListSnapshot })
          .returning();
        madeId = made!.id;
        pending = Promise.resolve(patchUrgent('alpha'));
        raced = await settled(pending);
      });
      expect(raced).toBe('blocked');
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        stopped: [],
        left: [{ id: madeId, title: 'Mid-create', status: 'created', currentStepId: null }],
        failed: [],
      });
      expect(await stampOf('alpha')).toBeInstanceOf(Date);
    });

    it("lets the boot's own update of the module row through while a create holds it", async () => {
      await insertType();
      let raced: string | undefined;
      await db.transaction(async (tx) => {
        await definitionForCreate(tx, TYPE, { generic: true });
        const update = db
          .update(schema.modules)
          .set({ missingAt: null })
          .where(eq(schema.modules.moduleId, 'alpha'))
          .then(() => 'done');
        raced = await Promise.race([
          update,
          new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 400)),
        ]);
        await update;
      });
      expect(raced).toBe('done');
    });

    it('makes a create that arrives while a deactivate holds the module row wait, then refuse by name', async () => {
      await insertType();
      let pending!: Promise<Response>;
      let raced: string | undefined;
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.modules)
          .where(eq(schema.modules.moduleId, 'alpha'))
          .for('update');
        await tx
          .update(schema.modules)
          .set({ deactivatedAt: new Date() })
          .where(eq(schema.modules.moduleId, 'alpha'));
        pending = Promise.resolve(postTask());
        raced = await settled(pending);
      });
      expect(raced).toBe('blocked');
      const res = await pending;
      expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([
        409,
        'module-deactivated',
      ]);
      expect(await typeTasks()).toHaveLength(0);
    });
  });
});
