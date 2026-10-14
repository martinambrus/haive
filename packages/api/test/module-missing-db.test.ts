import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.MODULE_MISSING_API_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_missing_api_test'))
  throw new Error('Use a dedicated module_missing_api_test database for module reason tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'admin',
  flags: new Map<string, boolean>(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ get: async () => null }) }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ACTOR);
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getFresh: async () => null,
    set: async () => undefined,
    setIfAbsent: async () => undefined,
    getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
  },
}));

import { Hono } from 'hono';
import { CONFIG_KEYS } from '@haive/shared';
import type { ComposableStepEntry } from '@haive/shared/modularity';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { adminTaskTypeRoutes, taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ACTOR = '00000000-0000-4000-8000-0000000000b1';
const USER_EMAIL_INDEX = 'module-missing-api-test-user';

const entry = (stepId: string, over: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'build',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...over,
});
const catalogRow = (
  stepId: string,
  source: string,
  entryValue: ComposableStepEntry | null,
): typeof schema.stepCatalog.$inferInsert => ({
  stepId,
  source,
  title: stepId,
  workflowType: 'workflow',
  dispatchesCli: false,
  allowSkip: false,
  providerSensitive: false,
  composable: entryValue !== null,
  entry: entryValue,
});
const CATALOG = [
  catalogRow('mm-core', 'core', entry('mm-core')),
  catalogRow('mm-a', 'core', entry('mm-a', { provides: ['mm-token'] })),
  catalogRow(
    'mm-b',
    'core',
    entry('mm-b', { requires: [{ needs: 'mm-token', reason: 'needs the token' }] }),
  ),
  catalogRow('mm-internal', 'core', null),
  catalogRow('module.fx.run', 'module:fx', entry('module.fx.run')),
  catalogRow('module.hx.run', 'module:hx', entry('module.hx.run')),
  catalogRow('module.ix.run', 'module:ix', entry('module.ix.run')),
];

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/task-types', taskTypeRoutes);
app.route('/tasks', taskRoutes);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T>(path: string) => (await (await send('GET', path)).json()) as T;

interface Availability {
  available: boolean;
  reason?: string;
  stepIds?: string[];
  modules?: { id: string; name: string | null }[];
}

describe.skipIf(!url)('module reasons on Postgres', () => {
  let db: Database;

  const setModule = (
    moduleId: string,
    name: string,
    over: Partial<typeof schema.modules.$inferInsert> = {},
  ) =>
    db.insert(schema.modules).values({
      moduleId,
      packageName: `@haive/module-${moduleId}`,
      name,
      installedVersion: '1.0.0',
      ...over,
    });
  const patchModule = (moduleId: string, over: Partial<typeof schema.modules.$inferInsert>) =>
    db.update(schema.modules).set(over).where(eq(schema.modules.moduleId, moduleId));
  const insertType = (
    slug: string,
    over: Partial<typeof schema.taskTypeDefinitions.$inferInsert> = {},
  ) =>
    db.insert(schema.taskTypeDefinitions).values({
      slug,
      displayName: `Type ${slug}`,
      runListStrategy: 'static',
      stepIds: ['mm-core'],
      source: 'admin',
      requiresRepository: false,
      ...over,
    });
  const postTask = (type: string) =>
    send('POST', '/tasks', { type, title: type, description: 'do' });
  const tasksOf = (type: string) =>
    db.select().from(schema.tasks).where(eq(schema.tasks.type, type));
  const published = async (slug: string) =>
    (await json<{ taskTypes: (Availability & { slug: string })[] }>('/task-types')).taskTypes.find(
      (t) => t.slug === slug,
    );
  const detail = async (slug: string) =>
    (await json<{ availability: Availability }>(`/admin/task-types/${slug}`)).availability;
  const listed = async (slug: string) =>
    (
      await json<{ taskTypes: { slug: string; availability: Availability }[] }>('/admin/task-types')
    ).taskTypes.find((t) => t.slug === slug)?.availability;

  const clean = async () => {
    await db.delete(schema.tasks).where(like(schema.tasks.type, 'mm-%'));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(like(schema.taskTypeDefinitions.slug, 'mm-%'));
    await db.delete(schema.modules);
    await db.delete(schema.stepCatalog);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.insert(schema.users).values({
      id: ACTOR,
      emailEncrypted: 'module-missing-api-test@test.local',
      emailBlindIndex: USER_EMAIL_INDEX,
      passwordHash: 'not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
    });
  });

  afterAll(async () => {
    await clean();
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    h.role = 'admin';
    h.flags = new Map([
      [CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED, true],
      [CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, true],
    ]);
    await clean();
    await db.insert(schema.stepCatalog).values(CATALOG);
    await setModule('fx', 'Fx Reports');
    await setModule('ix', 'Ix Loaded');
  });

  describe('POST /tasks', () => {
    it('refuses a type its module left, naming the module, and creates once the module is back', async () => {
      await insertType('mm-seeded', { source: 'module:fx', stepIds: ['mm-core'] });
      expect((await postTask('mm-seeded')).status).toBe(201);
      await db.delete(schema.tasks).where(eq(schema.tasks.type, 'mm-seeded'));

      await patchModule('fx', { missingAt: new Date() });
      const refused = await postTask('mm-seeded');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: expect.stringContaining('Fx Reports'),
        code: 'module-missing',
      });
      expect(await tasksOf('mm-seeded')).toHaveLength(0);

      await patchModule('fx', { missingAt: null });
      expect((await postTask('mm-seeded')).status).toBe(201);
      expect(await tasksOf('mm-seeded')).toHaveLength(1);
    });

    it('reads a module with no row as missing and names it by id', async () => {
      await insertType('mm-purged', { source: 'module:gx', stepIds: ['mm-core'] });
      const refused = await postTask('mm-purged');
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { error: string; code: string };
      expect(body.code).toBe('module-missing');
      expect(body.error).toContain('gx');
      expect(body.error).not.toMatch(/null|undefined/);
      expect(await tasksOf('mm-purged')).toHaveLength(0);
    });

    it('says module-missing, not missing-step, for a step of a module that left', async () => {
      await insertType('mm-step', { stepIds: ['mm-core', 'module.fx.run'] });
      expect((await postTask('mm-step')).status).toBe(201);
      await db.delete(schema.tasks).where(eq(schema.tasks.type, 'mm-step'));

      await patchModule('fx', { missingAt: new Date() });
      await db.delete(schema.stepCatalog).where(eq(schema.stepCatalog.source, 'module:fx'));
      const refused = await postTask('mm-step');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: expect.stringContaining('Fx Reports'),
        code: 'module-missing',
      });
      expect(await tasksOf('mm-step')).toHaveLength(0);
    });

    it('names every module that left, and each once', async () => {
      await insertType('mm-two', {
        stepIds: ['mm-core', 'module.fx.run', 'module.gx.run', 'module.gx.other'],
      });
      await patchModule('fx', { missingAt: new Date() });
      const body = (await (await postTask('mm-two')).json()) as { error: string };
      expect(body.error).toContain('Fx Reports');
      expect(body.error).toContain('gx');
      expect(body.error.match(/gx/g)).toHaveLength(1);
    });

    it('stays missing-step when the module is there and the step is not', async () => {
      await insertType('mm-gone', { stepIds: ['mm-core', 'module.ix.gone'] });
      const refused = await postTask('mm-gone');
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: expect.stringContaining('module.ix.gone'),
        code: 'missing-step',
      });
    });

    it('creates from a type whose modules are all there', async () => {
      await insertType('mm-fine', { source: 'module:ix', stepIds: ['mm-core', 'module.ix.run'] });
      expect((await postTask('mm-fine')).status).toBe(201);
    });
  });

  describe('GET /task-types', () => {
    it('lists a type whose module left as unavailable, with the module and its name', async () => {
      await insertType('mm-seeded', { source: 'module:fx' });
      await patchModule('fx', { missingAt: new Date() });
      expect(await published('mm-seeded')).toMatchObject({
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'fx', name: 'Fx Reports' }],
      });
    });

    it('gives no name for a module with no row', async () => {
      await insertType('mm-purged', { stepIds: ['mm-core', 'module.gx.run'] });
      expect(await published('mm-purged')).toMatchObject({
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'gx', name: null }],
      });
    });

    it('names the module of a deactivated one too', async () => {
      await setModule('hx', 'Hx Tools', { deactivatedAt: new Date() });
      await insertType('mm-off', { stepIds: ['mm-core', 'module.hx.run'] });
      expect(await published('mm-off')).toMatchObject({
        available: false,
        reason: 'module-deactivated',
        modules: [{ id: 'hx', name: 'Hx Tools' }],
      });
    });

    it('names the missing steps of a module that is there', async () => {
      await insertType('mm-gone', { stepIds: ['mm-core', 'mm-ghost', 'module.ix.gone'] });
      const entry = await published('mm-gone');
      expect(entry).toMatchObject({
        available: false,
        reason: 'missing-step',
        stepIds: ['mm-ghost', 'module.ix.gone'],
      });
      expect(entry?.modules).toBeUndefined();
    });

    it('carries neither reason nor detail for a type that is available', async () => {
      await insertType('mm-fine', { source: 'module:ix', stepIds: ['mm-core', 'module.ix.run'] });
      const entry = await published('mm-fine');
      expect(entry?.available).toBe(true);
      const keys = Object.keys(entry ?? {});
      for (const absent of ['reason', 'modules', 'stepIds']) expect(keys).not.toContain(absent);
    });

    it('keeps a disabled or not-selectable type out of the list', async () => {
      await insertType('mm-off', { source: 'module:fx', enabled: false });
      await insertType('mm-hidden', { source: 'module:fx', selectable: false });
      await patchModule('fx', { missingAt: new Date() });
      h.role = 'user';
      expect(await published('mm-off')).toBeUndefined();
      expect(await published('mm-hidden')).toBeUndefined();
    });

    it('answers a module switch that is off before the module', async () => {
      h.flags.set(CONFIG_KEYS.MODULE_TASK_TYPES_ENABLED, false);
      await insertType('mm-seeded', { source: 'module:fx' });
      await patchModule('fx', { missingAt: new Date() });
      expect(await published('mm-seeded')).toMatchObject({
        available: false,
        reason: 'module-types-off',
      });
    });

    it('checks the composition of a module type only while every step is composable', async () => {
      await insertType('mm-order', { source: 'module:ix', stepIds: ['mm-b', 'mm-a'] });
      await insertType('mm-internal', {
        source: 'module:ix',
        stepIds: ['mm-b', 'mm-a', 'mm-internal'],
      });
      expect(await published('mm-order')).toMatchObject({
        available: false,
        reason: 'invalid-composition',
      });
      expect(await published('mm-internal')).toMatchObject({ available: true });
    });
  });

  describe('GET /admin/task-types', () => {
    it('reports the missing module on the list and on the detail, and clears it when it is back', async () => {
      await insertType('mm-seeded', { source: 'module:fx' });
      expect(await detail('mm-seeded')).toEqual({ available: true });
      expect(await listed('mm-seeded')).toEqual({ available: true });

      await patchModule('fx', { missingAt: new Date() });
      const unavailable = {
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'fx', name: 'Fx Reports' }],
      };
      expect(await detail('mm-seeded')).toEqual(unavailable);
      expect(await listed('mm-seeded')).toEqual(unavailable);

      await patchModule('fx', { missingAt: null });
      expect(await detail('mm-seeded')).toEqual({ available: true });
      expect(await listed('mm-seeded')).toEqual({ available: true });
    });

    it('reports a module with no row with a null name', async () => {
      await insertType('mm-purged', { stepIds: ['mm-core', 'module.gx.run'] });
      const unavailable = {
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'gx', name: null }],
      };
      expect(await detail('mm-purged')).toEqual(unavailable);
      expect(await listed('mm-purged')).toEqual(unavailable);
    });

    it('keeps missing-step with its ids for a step of a module that is there', async () => {
      await insertType('mm-gone', { stepIds: ['mm-core', 'module.ix.gone'] });
      const unavailable = {
        available: false,
        reason: 'missing-step',
        stepIds: ['module.ix.gone'],
      };
      expect(await detail('mm-gone')).toEqual(unavailable);
      expect(await listed('mm-gone')).toEqual(unavailable);
    });
  });

  describe('GET /admin/task-types/catalog', () => {
    type CatalogBody = {
      steps: { stepId: string }[];
      modules: { id: string; name: string; state: string }[];
      registeredStepIds: string[];
    };
    const catalog = () => json<CatalogBody>('/admin/task-types/catalog');

    it('lists every module with its name and state', async () => {
      await setModule('hx', 'Hx Tools', { deactivatedAt: new Date() });
      await setModule('jx', 'Jx Both', { deactivatedAt: new Date(), missingAt: new Date() });
      await patchModule('fx', { missingAt: new Date() });
      expect((await catalog()).modules).toEqual([
        { id: 'fx', name: 'Fx Reports', state: 'missing' },
        { id: 'hx', name: 'Hx Tools', state: 'deactivated' },
        { id: 'ix', name: 'Ix Loaded', state: 'loaded' },
        { id: 'jx', name: 'Jx Both', state: 'missing' },
      ]);
    });

    it('lists none while the modules table is empty', async () => {
      await db.delete(schema.modules);
      expect((await catalog()).modules).toEqual([]);
    });

    it('lists every registered step, composable or not, and the steps of a deactivated module', async () => {
      await setModule('hx', 'Hx Tools', { deactivatedAt: new Date() });
      const body = await catalog();
      expect([...body.registeredStepIds].sort()).toEqual(CATALOG.map((r) => r.stepId).sort());
      expect(body.steps.map((s) => s.stepId)).not.toContain('mm-internal');
      expect(body.steps.map((s) => s.stepId)).not.toContain('module.hx.run');
      expect(body.registeredStepIds).toContain('module.hx.run');
    });
  });
});
