import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TASK_TYPES_API_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_types_api_test'))
  throw new Error('Use a dedicated task_types_api_test database for task type route tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'admin',
  flags: new Map<string, boolean>(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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
    getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
  },
}));

import { Hono } from 'hono';
import type { ComposableStepEntry } from '@haive/shared/modularity';
import { adminTaskTypeRoutes, taskTypeRoutes } from '../src/routes/task-types.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const CUSTOM_KEY = 'config:taskTypes:customEnabled';
const MODULE_KEY = 'config:taskTypes:moduleEnabled';
const USER_EMAIL_INDEX = 'task-types-api-test-user';

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
  composable: boolean,
  entryValue: unknown,
  source = 'core',
): typeof schema.stepCatalog.$inferInsert => ({
  stepId,
  source,
  title: stepId,
  workflowType: 'workflow',
  dispatchesCli: false,
  allowSkip: false,
  providerSensitive: false,
  composable,
  entry: entryValue,
});

const CATALOG = [
  catalogRow('ta-a', true, entry('ta-a', { provides: ['x'], agentAuthoredOutput: true })),
  catalogRow(
    'ta-b',
    true,
    entry('ta-b', {
      requires: [{ needs: 'x', reason: 'needs x' }],
      provides: ['y'],
      loopBudgetEditable: true,
    }),
  ),
  catalogRow('ta-c', true, entry('ta-c', { requires: [{ needs: 'zzz', reason: 'needs zzz' }] })),
  catalogRow('ta-plain', false, null),
  catalogRow('ta-corrupt', true, { stepId: 'ta-corrupt', bad: 1 }),
];

const builtin = (slug: string, over: Partial<typeof schema.taskTypeDefinitions.$inferInsert>) => ({
  slug,
  displayName: slug,
  runListStrategy: 'static' as const,
  stepIds: ['ta-plain'],
  source: 'builtin',
  ...over,
});

const app = new Hono<AppEnv>();
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/task-types', taskTypeRoutes);
app.onError(errorHandler);

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const valid = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  displayName: `Type ${slug}`,
  stepIds: ['ta-a', 'ta-b'],
  requiresRepository: true,
  ...over,
});

describe.skipIf(!url)('task type routes on Postgres', () => {
  let db: Database;

  const clean = async () => {
    await db.delete(schema.tasks).where(like(schema.tasks.type, 'tt-%'));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(like(schema.taskTypeDefinitions.slug, 'tt-%'));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, ['workflow', 'plan_merge', 'run_app']));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'task_type'));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'acme'));
  };
  const seedCatalog = async () => {
    await db.delete(schema.stepCatalog);
    await db.insert(schema.stepCatalog).values(CATALOG);
  };
  const row = async (slug: string) =>
    (
      await db
        .select()
        .from(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.slug, slug))
    )[0];
  const audits = async () =>
    (
      await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetType, 'task_type'))
    )
      .map((e) => `${e.action}:${(e.metadata as { slug: string }).slug}`)
      .sort();
  const taskFor = async (type: string) => {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.insert(schema.tasks).values({ userId: user!.id, type, title: type });
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await clean();
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    await db.insert(schema.users).values({
      emailEncrypted: 'task-types-api-test@test.local',
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
    h.flags = new Map();
    await clean();
    await seedCatalog();
    await db
      .insert(schema.taskTypeDefinitions)
      .values([
        builtin('workflow', { runListStrategy: 'workflow_paths', stepIds: null, sortOrder: 1 }),
        builtin('plan_merge', { selectable: false, sortOrder: 2 }),
      ]);
  });

  describe('POST /admin/task-types', () => {
    it('creates a static admin type with the server-owned fields fixed', async () => {
      const res = await send('POST', '/admin/task-types', valid('tt-ok', { description: 'd' }));
      expect(res.status).toBe(201);
      const stored = await row('tt-ok');
      expect(stored).toMatchObject({
        slug: 'tt-ok',
        source: 'admin',
        runListStrategy: 'static',
        stepIds: ['ta-a', 'ta-b'],
        fixLoop: null,
        contentHash: null,
        enabled: true,
        selectable: true,
        requiresRepository: true,
        description: 'd',
        preAnswerDefaults: {},
        stepLoopLimitDefaults: {},
      });
      expect(await audits()).toEqual(['task_type.create:tt-ok']);
    });

    it('rejects a composition the catalog rules refuse, storing nothing', async () => {
      const res = await send('POST', '/admin/task-types', valid('tt-bad', { stepIds: ['ta-c'] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { kind: string }[] };
      expect(body.issues.map((i) => i.kind)).toContain('unmet-need');
      expect(await row('tt-bad')).toBeUndefined();
      expect(await audits()).toEqual([]);
    });

    it('treats a non-composable and an absent step as unknown', async () => {
      const res = await send(
        'POST',
        '/admin/task-types',
        valid('tt-unk', { stepIds: ['ta-plain', 'ta-missing', 'ta-corrupt'] }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { issues: { kind: string; stepId: string }[] };
      expect(body.issues.filter((i) => i.kind === 'unknown-step').map((i) => i.stepId)).toEqual([
        'ta-plain',
        'ta-missing',
        'ta-corrupt',
      ]);
    });

    it('refuses with 409 while the step catalog has not been synced', async () => {
      await db.delete(schema.stepCatalog);
      const res = await send('POST', '/admin/task-types', valid('tt-empty'));
      expect(res.status).toBe(409);
      expect(await row('tt-empty')).toBeUndefined();
    });

    it('refuses a built-in slug and a duplicate with 409, and a bad slug with 400', async () => {
      expect((await send('POST', '/admin/task-types', valid('workflow'))).status).toBe(409);
      expect((await send('POST', '/admin/task-types', valid('plan_build'))).status).toBe(409);
      expect((await send('POST', '/admin/task-types', valid('tt-dup'))).status).toBe(201);
      expect((await send('POST', '/admin/task-types', valid('tt-dup'))).status).toBe(409);
      expect((await send('POST', '/admin/task-types', valid('tt_under'))).status).toBe(400);
      expect((await row('workflow'))?.source).toBe('builtin');
    });

    it('refuses fields the server owns', async () => {
      const res = await send('POST', '/admin/task-types', valid('tt-src', { source: 'builtin' }));
      expect(res.status).toBe(400);
      expect(await row('tt-src')).toBeUndefined();
    });

    it('checks the defaults against the steps and the loop-budget flag', async () => {
      const outside = await send(
        'POST',
        '/admin/task-types',
        valid('tt-def1', { preAnswerDefaults: { 'ta-c': { a: 1 } } }),
      );
      expect(outside.status).toBe(400);
      const notEditable = await send(
        'POST',
        '/admin/task-types',
        valid('tt-def2', { stepLoopLimitDefaults: { 'ta-a': 3 } }),
      );
      expect(notEditable.status).toBe(400);
      const tooMany = await send(
        'POST',
        '/admin/task-types',
        valid('tt-def3', { stepLoopLimitDefaults: { 'ta-b': 99 } }),
      );
      expect(tooMany.status).toBe(400);
      const ok = await send(
        'POST',
        '/admin/task-types',
        valid('tt-def4', {
          preAnswerDefaults: { 'ta-a': { a: 1 } },
          stepLoopLimitDefaults: { 'ta-b': 3 },
        }),
      );
      expect(ok.status).toBe(201);
      expect(await row('tt-def4')).toMatchObject({
        preAnswerDefaults: { 'ta-a': { a: 1 } },
        stepLoopLimitDefaults: { 'ta-b': 3 },
      });
    });
  });

  describe('PATCH /admin/task-types/:slug', () => {
    it('lets a built-in change its display fields only', async () => {
      const ok = await send('PATCH', '/admin/task-types/workflow', {
        displayName: 'Feature work',
        sortOrder: 9,
      });
      expect(ok.status).toBe(200);
      expect(await row('workflow')).toMatchObject({ displayName: 'Feature work', sortOrder: 9 });
      for (const body of [
        { stepIds: ['ta-a'] },
        { requiresRepository: false },
        { preAnswerDefaults: {} },
        { selectable: false },
      ]) {
        expect((await send('PATCH', '/admin/task-types/workflow', body)).status).toBe(400);
      }
      expect(await row('workflow')).toMatchObject({ stepIds: null, selectable: true });
    });

    it('allows disabling a selectable built-in but not an internal one', async () => {
      expect((await send('PATCH', '/admin/task-types/plan_merge', { enabled: false })).status).toBe(
        400,
      );
      expect((await row('plan_merge'))?.enabled).toBe(true);
      expect((await send('PATCH', '/admin/task-types/workflow', { enabled: false })).status).toBe(
        400,
      );
      expect((await row('workflow'))?.enabled).toBe(true);
      await db.insert(schema.taskTypeDefinitions).values(builtin('run_app', { sortOrder: 3 }));
      expect((await send('PATCH', '/admin/task-types/run_app', { enabled: false })).status).toBe(
        200,
      );
      expect((await row('run_app'))?.enabled).toBe(false);
    });

    it('accepts a custom type without a repository when its steps need none', async () => {
      const res = await send(
        'POST',
        '/admin/task-types',
        valid('tt-norepo', { requiresRepository: false }),
      );
      expect(res.status).toBe(201);
      expect((await row('tt-norepo'))?.requiresRepository).toBe(false);
      expect((await send('POST', '/admin/task-types', valid('tt-repo'))).status).toBe(201);
      expect(
        (await send('PATCH', '/admin/task-types/tt-repo', { requiresRepository: false })).status,
      ).toBe(200);
      expect((await row('tt-repo'))?.requiresRepository).toBe(false);
    });

    it('validates an edit against the row as committed by a concurrent edit', async () => {
      await send('POST', '/admin/task-types', valid('tt-conc'));
      let locked!: () => void;
      const holding = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const dropping = db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, 'tt-conc'))
          .for('update');
        await tx
          .update(schema.taskTypeDefinitions)
          .set({ stepIds: ['ta-a'] })
          .where(eq(schema.taskTypeDefinitions.slug, 'tt-conc'));
        locked();
        await gate;
      });
      await holding;
      const patching = send('PATCH', '/admin/task-types/tt-conc', {
        stepLoopLimitDefaults: { 'ta-b': 3 },
      });
      await new Promise((r) => setTimeout(r, 300));
      release();
      await dropping;
      expect((await patching).status).toBe(400);
      expect((await row('tt-conc'))?.stepLoopLimitDefaults).toEqual({});
    });

    it('edits a custom type, revalidating the composition and the defaults', async () => {
      await send('POST', '/admin/task-types', valid('tt-edit'));
      const bad = await send('PATCH', '/admin/task-types/tt-edit', { stepIds: ['ta-c'] });
      expect(bad.status).toBe(400);
      expect((await row('tt-edit'))?.stepIds).toEqual(['ta-a', 'ta-b']);

      const orphan = await send('PATCH', '/admin/task-types/tt-edit', {
        stepIds: ['ta-a'],
        stepLoopLimitDefaults: { 'ta-b': 2 },
      });
      expect(orphan.status).toBe(400);

      const ok = await send('PATCH', '/admin/task-types/tt-edit', {
        stepIds: ['ta-a'],
        displayName: 'Edited',
        enabled: false,
        selectable: false,
      });
      expect(ok.status).toBe(200);
      expect(await row('tt-edit')).toMatchObject({
        stepIds: ['ta-a'],
        displayName: 'Edited',
        requiresRepository: true,
        enabled: false,
        selectable: false,
        source: 'admin',
      });
      expect(await audits()).toEqual(['task_type.create:tt-edit', 'task_type.update:tt-edit']);
    });

    it('never moves the slug, source or strategy of a custom type', async () => {
      await send('POST', '/admin/task-types', valid('tt-fixed'));
      for (const body of [{ slug: 'other' }, { source: 'builtin' }, { runListStrategy: 'x' }]) {
        expect((await send('PATCH', '/admin/task-types/tt-fixed', body)).status).toBe(400);
      }
    });

    it('lets a module type be disabled and reordered but not recomposed', async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-mod',
        displayName: 'Mod',
        runListStrategy: 'static',
        stepIds: ['ta-a'],
        source: 'module:acme',
      });
      expect(
        (await send('PATCH', '/admin/task-types/tt-mod', { enabled: false, sortOrder: 4 })).status,
      ).toBe(200);
      expect(await row('tt-mod')).toMatchObject({ enabled: false, sortOrder: 4 });
      expect((await send('PATCH', '/admin/task-types/tt-mod', { stepIds: ['ta-b'] })).status).toBe(
        400,
      );
    });

    it('answers 404 for an unknown slug', async () => {
      expect((await send('PATCH', '/admin/task-types/tt-none', { displayName: 'x' })).status).toBe(
        404,
      );
    });
  });

  describe('DELETE /admin/task-types/:slug', () => {
    it('waits for a task insert in flight, then refuses the delete', async () => {
      await send('POST', '/admin/task-types', valid('tt-race'));
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
      let locked!: () => void;
      const holding = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const creating = db.transaction(async (tx) => {
        await tx
          .select()
          .from(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, 'tt-race'))
          .for('share');
        await tx.insert(schema.tasks).values({ userId: user!.id, type: 'tt-race', title: 'race' });
        locked();
        await gate;
      });
      await holding;
      const deleting = send('DELETE', '/admin/task-types/tt-race');
      await new Promise((r) => setTimeout(r, 300));
      release();
      await creating;
      expect((await deleting).status).toBe(409);
      expect(await row('tt-race')).toBeDefined();
    });

    it('refuses with 409 while a task has the type, then deletes once none does', async () => {
      await send('POST', '/admin/task-types', valid('tt-del'));
      await taskFor('tt-del');
      expect((await send('DELETE', '/admin/task-types/tt-del')).status).toBe(409);
      expect(await row('tt-del')).toBeDefined();
      await db.delete(schema.tasks).where(eq(schema.tasks.type, 'tt-del'));
      expect((await send('DELETE', '/admin/task-types/tt-del')).status).toBe(204);
      expect(await row('tt-del')).toBeUndefined();
      expect(await audits()).toEqual(['task_type.create:tt-del', 'task_type.delete:tt-del']);
    });

    it('refuses a built-in and a module type, and 404s an unknown one', async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-mod',
        displayName: 'Mod',
        runListStrategy: 'static',
        stepIds: ['ta-a'],
        source: 'module:acme',
      });
      expect((await send('DELETE', '/admin/task-types/workflow')).status).toBe(400);
      expect((await send('DELETE', '/admin/task-types/tt-mod')).status).toBe(400);
      expect((await send('DELETE', '/admin/task-types/tt-none')).status).toBe(404);
      expect(await row('workflow')).toBeDefined();
      expect(await row('tt-mod')).toBeDefined();
    });
  });

  describe('GET /admin/task-types', () => {
    it('lists every row with its source flag, availability and task count', async () => {
      await send('POST', '/admin/task-types', valid('tt-list'));
      await taskFor('tt-list');
      const res = await send('GET', '/admin/task-types');
      expect(res.status).toBe(200);
      type Listed = {
        slug: string;
        builtin: boolean;
        taskCount: number;
        availability: { available: boolean; reason?: string };
      };
      const { taskTypes } = (await res.json()) as { taskTypes: Listed[] };
      const by = new Map(taskTypes.map((t) => [t.slug, t]));
      expect(by.get('workflow')).toMatchObject({ builtin: true, taskCount: 0 });
      expect(by.get('tt-list')).toMatchObject({
        builtin: false,
        taskCount: 1,
        availability: { available: false, reason: 'custom-types-off' },
      });
      expect(by.get('plan_merge')?.availability).toMatchObject({
        available: false,
        reason: 'not-selectable',
      });
      h.flags.set(CUSTOM_KEY, true);
      const again = (await (await send('GET', '/admin/task-types')).json()) as {
        taskTypes: typeof taskTypes;
      };
      expect(again.taskTypes.find((t) => t.slug === 'tt-list')?.availability).toEqual({
        available: true,
      });
    });

    it('returns one row with its composition issues', async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-stale',
        displayName: 'Stale',
        runListStrategy: 'static',
        stepIds: ['ta-c'],
        source: 'admin',
      });
      const res = await send('GET', '/admin/task-types/tt-stale');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        taskType: { slug: string };
        compositionIssues: { kind: string }[];
      };
      expect(body.taskType.slug).toBe('tt-stale');
      expect(body.compositionIssues.map((i) => i.kind)).toEqual(['unmet-need']);
      expect((await send('GET', '/admin/task-types/tt-none')).status).toBe(404);
    });
  });

  describe('editableFields', () => {
    const CUSTOM_FIELDS = [
      'description',
      'displayName',
      'enabled',
      'preAnswerDefaults',
      'promptSteps',
      'requiresRepository',
      'selectable',
      'sortOrder',
      'stepIds',
      'stepLoopLimitDefaults',
    ];

    it('lists the fields a PATCH accepts for a built-in, a custom and a module row', async () => {
      await db.insert(schema.taskTypeDefinitions).values([
        builtin('run_app', { runListStrategy: 'run_app_modes', stepIds: null, sortOrder: 3 }),
        {
          slug: 'tt-custom',
          displayName: 'Custom',
          runListStrategy: 'static',
          stepIds: ['ta-a'],
          source: 'admin',
        },
        {
          slug: 'tt-mod-fields',
          displayName: 'Mod',
          runListStrategy: 'static',
          stepIds: ['ta-a'],
          source: 'module:acme',
        },
      ]);
      const list = (await (await send('GET', '/admin/task-types')).json()) as {
        taskTypes: { slug: string; editableFields: string[] }[];
      };
      const fields = (slug: string) =>
        [...(list.taskTypes.find((t) => t.slug === slug)?.editableFields ?? [])].sort();
      expect(fields('workflow')).toEqual(['description', 'displayName', 'sortOrder']);
      expect(fields('plan_merge')).toEqual(['description', 'displayName', 'sortOrder']);
      expect(fields('run_app')).toEqual(['description', 'displayName', 'enabled', 'sortOrder']);
      expect(fields('tt-custom')).toEqual(CUSTOM_FIELDS);
      expect(fields('tt-mod-fields')).toEqual(['displayName', 'enabled', 'sortOrder']);

      for (const slug of ['workflow', 'tt-custom', 'tt-mod-fields']) {
        const one = (await (await send('GET', `/admin/task-types/${slug}`)).json()) as {
          taskType: { editableFields: string[] };
        };
        expect([...one.taskType.editableFields].sort()).toEqual(fields(slug));
      }
    });

    it('returns them from a create and an update too', async () => {
      const created = await send('POST', '/admin/task-types', valid('tt-write'));
      expect(created.status).toBe(201);
      const c = (await created.json()) as { taskType: { editableFields: string[] } };
      expect([...c.taskType.editableFields].sort()).toEqual(CUSTOM_FIELDS);
      const updated = await send('PATCH', '/admin/task-types/tt-write', { displayName: 'W' });
      expect(updated.status).toBe(200);
      const u = (await updated.json()) as { taskType: { editableFields: string[] } };
      expect([...u.taskType.editableFields].sort()).toEqual(CUSTOM_FIELDS);
    });
  });

  describe('public traits', () => {
    it('reports restoresDatabase and dispatchesCli per row', async () => {
      await db.insert(schema.stepCatalog).values([
        catalogRow('01c1-restore-database', true, entry('01c1-restore-database')),
        {
          ...catalogRow('ta-agent', true, entry('ta-agent', { dispatchesCli: true })),
          dispatchesCli: true,
        },
      ]);
      const custom = (slug: string, stepIds: string[], source = 'admin') => ({
        slug,
        displayName: slug,
        runListStrategy: 'static' as const,
        stepIds,
        source,
      });
      await db
        .insert(schema.taskTypeDefinitions)
        .values([
          custom('tt-plain-t', ['ta-a', 'ta-b']),
          custom('tt-restore-t', ['01c1-restore-database', 'ta-a']),
          custom('tt-agent-t', ['ta-a', 'ta-agent']),
          custom('tt-both-t', ['01c1-restore-database', 'ta-agent']),
          custom('tt-mod-restore', ['01c1-restore-database'], 'module:acme'),
        ]);
      h.flags.set(CUSTOM_KEY, true);
      h.flags.set(MODULE_KEY, true);
      h.role = 'user';
      const { taskTypes } = (await (await send('GET', '/task-types')).json()) as {
        taskTypes: { slug: string; restoresDatabase: boolean; dispatchesCli: boolean }[];
      };
      const traits = (slug: string) => {
        const t = taskTypes.find((x) => x.slug === slug);
        return { restoresDatabase: t?.restoresDatabase, dispatchesCli: t?.dispatchesCli };
      };
      expect(traits('tt-plain-t')).toEqual({ restoresDatabase: false, dispatchesCli: false });
      expect(traits('tt-restore-t')).toEqual({ restoresDatabase: true, dispatchesCli: false });
      expect(traits('tt-agent-t')).toEqual({ restoresDatabase: false, dispatchesCli: true });
      expect(traits('tt-both-t')).toEqual({ restoresDatabase: true, dispatchesCli: true });
      expect(traits('tt-mod-restore')).toEqual({ restoresDatabase: true, dispatchesCli: false });
      expect(traits('workflow')).toEqual({ restoresDatabase: true, dispatchesCli: true });
    });

    it('reports dispatchesCli while the step catalog is unsynced', async () => {
      await db.delete(schema.stepCatalog);
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-unsynced',
        displayName: 'tt-unsynced',
        runListStrategy: 'static',
        stepIds: ['ta-a'],
        source: 'admin',
      });
      h.flags.set(CUSTOM_KEY, true);
      h.role = 'user';
      const { taskTypes } = (await (await send('GET', '/task-types')).json()) as {
        taskTypes: { slug: string; dispatchesCli: boolean }[];
      };
      expect(taskTypes.find((t) => t.slug === 'tt-unsynced')?.dispatchesCli).toBe(true);
    });
  });

  describe('GET /admin/task-types/catalog', () => {
    it('lists the composable steps, omits a corrupt entry, and reports the sync state', async () => {
      const res = await send('GET', '/admin/task-types/catalog');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        steps: { stepId: string; source: string; title: string; entry: ComposableStepEntry }[];
        groups: { id: string; label: string }[];
        synced: boolean;
      };
      expect(body.steps.map((s) => s.stepId).sort()).toEqual(['ta-a', 'ta-b', 'ta-c']);
      expect(body.steps.find((s) => s.stepId === 'ta-b')?.entry.loopBudgetEditable).toBe(true);
      expect(body.groups.map((g) => g.id)).toContain('build');
      expect(body.synced).toBe(true);

      await db.delete(schema.stepCatalog);
      const empty = (await (await send('GET', '/admin/task-types/catalog')).json()) as typeof body;
      expect(empty).toMatchObject({ steps: [], synced: false });
    });
  });

  describe('GET /task-types', () => {
    it('lists a type behind an off switch as unavailable with that reason, not hidden', async () => {
      await db.insert(schema.modules).values({
        moduleId: 'acme',
        packageName: '@haive/module-acme',
        name: 'Acme',
        installedVersion: '1.0.0',
      });
      await send('POST', '/admin/task-types', valid('tt-pub'));
      await send('POST', '/admin/task-types', valid('tt-off', { enabled: false }));
      await send('POST', '/admin/task-types', valid('tt-hidden', { selectable: false }));
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-mod',
        displayName: 'Mod',
        runListStrategy: 'static',
        stepIds: ['ta-a'],
        source: 'module:acme',
      });
      h.role = 'user';

      const rows = async () =>
        Object.fromEntries(
          (
            (await (await send('GET', '/task-types')).json()) as {
              taskTypes: { slug: string; available: boolean; reason?: string }[];
            }
          ).taskTypes.map((t) => [t.slug, t.available ? 'available' : t.reason]),
        );

      expect(await rows()).toEqual({
        'tt-mod': 'module-types-off',
        'tt-pub': 'custom-types-off',
        workflow: 'available',
      });
      h.flags.set(CUSTOM_KEY, true);
      h.flags.set(MODULE_KEY, true);
      expect(await rows()).toEqual({
        'tt-mod': 'available',
        'tt-pub': 'available',
        workflow: 'available',
      });
    });

    it('flags a type whose step has left the catalog instead of hiding it', async () => {
      h.flags.set(CUSTOM_KEY, true);
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-gone',
        displayName: 'Gone',
        runListStrategy: 'static',
        stepIds: ['ta-a', 'ta-vanished'],
        source: 'admin',
      });
      h.role = 'user';
      const { taskTypes } = (await (await send('GET', '/task-types')).json()) as {
        taskTypes: { slug: string; available: boolean; reason?: string }[];
      };
      expect(taskTypes.find((t) => t.slug === 'tt-gone')).toMatchObject({
        available: false,
        reason: 'missing-step',
      });
    });
  });

  describe('prompt steps', () => {
    const step = (slug: string, over: Record<string, unknown> = {}) => ({
      slug,
      title: `Step ${slug}`,
      template: 'Review {{task.title}}',
      timeoutMs: 300_000,
      ...over,
    });
    const httpTool = {
      name: 'repo_status',
      description: 'Fetches the status of the repository.',
      action: 'http-get',
      url: 'https://api.example.com/v1/status',
    };
    const ragTool = {
      name: 'house_rules',
      description: 'Searches the house rules.',
      action: 'rag-query',
      scope: 'global',
    };
    const CUSTOM_ID = 'custom.tt-ps.review';
    const withStep = (over: Record<string, unknown> = {}) =>
      valid('tt-ps', {
        stepIds: ['ta-a', CUSTOM_ID],
        promptSteps: { review: step('review') },
        ...over,
      });
    const issues = async (res: Response) =>
      ((await res.json()) as { issues: { kind: string; stepId?: string; message: string }[] })
        .issues;

    it('stores a valid prompt step with its type and reads the type as available', async () => {
      const res = await send('POST', '/admin/task-types', withStep());
      expect(res.status).toBe(201);
      expect((await row('tt-ps'))?.promptSteps).toEqual({
        review: { ...step('review'), capabilities: [], tools: [] },
      });
      h.flags.set(CUSTOM_KEY, true);
      const detail = (await (await send('GET', '/admin/task-types/tt-ps')).json()) as {
        availability: { available: boolean };
        compositionIssues: unknown[];
      };
      expect(detail.availability).toEqual({ available: true });
      expect(detail.compositionIssues).toEqual([]);
      const list = (await (await send('GET', '/admin/task-types')).json()) as {
        taskTypes: { slug: string; availability: { available: boolean } }[];
      };
      expect(list.taskTypes.find((t) => t.slug === 'tt-ps')?.availability.available).toBe(true);
      h.role = 'user';
      const pub = (await (await send('GET', '/task-types')).json()) as {
        taskTypes: { slug: string; available: boolean; dispatchesCli: boolean }[];
      };
      expect(pub.taskTypes.find((t) => t.slug === 'tt-ps')).toMatchObject({
        available: true,
        dispatchesCli: true,
      });
    });

    it('lets a step name an earlier step and refuses a later one', async () => {
      const ok = await send(
        'POST',
        '/admin/task-types',
        withStep({ promptSteps: { review: step('review', { template: 'Use\n{{step:ta-a}}\n' }) } }),
      );
      expect(ok.status).toBe(201);
      const late = await send(
        'POST',
        '/admin/task-types',
        withStep({
          slug: 'tt-ps2',
          stepIds: [CUSTOM_ID.replace('tt-ps', 'tt-ps2'), 'ta-a'],
          promptSteps: { review: step('review', { template: 'Use\n{{step:ta-a}}\n' }) },
        }),
      );
      expect(late.status).toBe(400);
      expect((await issues(late)).map((i) => i.kind)).toContain('step-token-not-earlier');
    });

    it('lets a step quote a flagged or same-type earlier step and refuses any other', async () => {
      const second = step('second', { template: 'Use\n{{step:custom.tt-ps.review}}\n' });
      const same = await send(
        'POST',
        '/admin/task-types',
        withStep({
          stepIds: ['ta-a', CUSTOM_ID, 'custom.tt-ps.second'],
          promptSteps: { review: step('review'), second },
        }),
      );
      expect(same.status).toBe(201);
      const refused = await send(
        'POST',
        '/admin/task-types',
        withStep({
          slug: 'tt-ps3',
          stepIds: ['ta-a', 'ta-b', CUSTOM_ID.replace('tt-ps', 'tt-ps3')],
          promptSteps: { review: step('review', { template: 'Use\n{{step:ta-b}}\n' }) },
        }),
      );
      expect(refused.status).toBe(400);
      const found = await issues(refused);
      expect(found.map((i) => i.kind)).toEqual(['step-token-not-quotable']);
      expect(found[0]!.message).toContain('ta-b');
    });

    it('applies the same rule to a PATCH', async () => {
      await send('POST', '/admin/task-types', withStep());
      const patch = (stepId: string) =>
        send('PATCH', '/admin/task-types/tt-ps', {
          stepIds: ['ta-a', 'ta-b', CUSTOM_ID],
          promptSteps: { review: step('review', { template: `Use\n{{step:${stepId}}}\n` }) },
        });
      const refused = await patch('ta-b');
      expect(refused.status).toBe(400);
      expect((await issues(refused)).map((i) => i.kind)).toEqual(['step-token-not-quotable']);
      expect((await patch('ta-a')).status).toBe(200);
    });

    it.each([
      ['unknown-token', { template: 'Say {{nope}}' }, {}],
      ['field-not-declared', { template: 'Say {{field:topic}}' }, {}],
      ['reserved-marker-in-template', { template: 'Say [[HAIVE_X]]' }, {}],
      ['integration-token', { template: 'Say {{integration:x}}' }, {}],
      ['step-token-not-own-line', { template: 'Say {{step:ta-a}} now' }, {}],
      ['persona-id-invalid', { template: 'Be {{agent:Bad_Id}}' }, {}],
      ['persona-without-repository', { template: 'Be {{agent:reviewer}}' }, { repo: false }],
      [
        'file-write-without-repository',
        { template: 'Do it', capabilities: ['file_write'] },
        { repo: false },
      ],
      ['tools-not-supported-yet', { tools: [httpTool] }, {}],
      ['tool-url-not-https', { tools: [{ ...httpTool, url: 'http://api.example.com/v1' }] }, {}],
      [
        'tool-scope-needs-repository',
        { tools: [{ ...ragTool, scope: 'project' }] },
        { repo: false },
      ],
    ])('refuses %s with a 400 naming it, storing nothing', async (kind, over, opts) => {
      const res = await send(
        'POST',
        '/admin/task-types',
        withStep({
          requiresRepository: (opts as { repo?: boolean }).repo ?? true,
          promptSteps: { review: step('review', over) },
        }),
      );
      expect(res.status).toBe(400);
      const found = await issues(res);
      expect(found.map((i) => i.kind)).toContain(kind);
      expect(found.find((i) => i.kind === kind)?.stepId).toBe(CUSTOM_ID);
      expect(await row('tt-ps')).toBeUndefined();
    });

    it('refuses a tool on a PATCH too, and leaves the stored step as it was', async () => {
      await send('POST', '/admin/task-types', withStep());
      const res = await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: { review: step('review', { tools: [httpTool] }) },
      });
      expect(res.status).toBe(400);
      expect(await issues(res)).toEqual([
        expect.objectContaining({ kind: 'tools-not-supported-yet', stepId: CUSTOM_ID }),
      ]);
      expect((await row('tt-ps'))?.promptSteps).toEqual({
        review: { ...step('review'), capabilities: [], tools: [] },
      });
    });

    it('refuses a step the schema bounds, and an entry keyed by another slug', async () => {
      for (const promptSteps of [
        { review: step('review', { timeoutMs: 5 }) },
        { review: step('review', { template: '' }) },
        { review: step('review', { tools: Array.from({ length: 9 }, () => httpTool) }) },
        { other: step('review') },
      ]) {
        const res = await send('POST', '/admin/task-types', withStep({ promptSteps }));
        expect(res.status).toBe(400);
      }
      expect(await row('tt-ps')).toBeUndefined();
    });

    it('refuses an entry the step list never uses', async () => {
      const res = await send(
        'POST',
        '/admin/task-types',
        withStep({
          stepIds: ['ta-a'],
          promptSteps: { review: step('review') },
        }),
      );
      expect(res.status).toBe(400);
      expect(await issues(res)).toEqual([
        expect.objectContaining({ kind: 'prompt-step-orphan', stepId: CUSTOM_ID }),
      ]);
      expect(await row('tt-ps')).toBeUndefined();
    });

    it('refuses a custom id that has no entry, or belongs to another type', async () => {
      for (const stepIds of [
        ['ta-a', CUSTOM_ID],
        ['ta-a', CUSTOM_ID, 'custom.tt-ps.second'],
        ['ta-a', 'custom.other.review'],
      ]) {
        const res = await send(
          'POST',
          '/admin/task-types',
          withStep({
            stepIds,
            promptSteps: stepIds.length === 3 ? { review: step('review') } : {},
          }),
        );
        expect(res.status).toBe(400);
        expect((await issues(res)).map((i) => i.kind)).toContain('prompt-step-missing');
      }
      expect(await row('tt-ps')).toBeUndefined();
    });

    it('keeps a type with no prompt steps exactly as it was', async () => {
      expect((await send('POST', '/admin/task-types', valid('tt-plain'))).status).toBe(201);
      expect((await row('tt-plain'))?.promptSteps).toEqual({});
    });

    it('edits a template, and revalidates it against the type as edited', async () => {
      await send('POST', '/admin/task-types', withStep());
      const ok = await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: { review: step('review', { template: 'New {{task.description}}' }) },
      });
      expect(ok.status).toBe(200);
      expect(
        ((await row('tt-ps'))?.promptSteps as { review: { template: string } }).review.template,
      ).toBe('New {{task.description}}');

      const bad = await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: { review: step('review', { template: '{{nope}}' }) },
      });
      expect(bad.status).toBe(400);
      expect((await issues(bad)).map((i) => i.kind)).toContain('unknown-token');

      await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: { review: step('review', { template: 'Be {{agent:reviewer}}' }) },
      });
      const norepo = await send('PATCH', '/admin/task-types/tt-ps', { requiresRepository: false });
      expect(norepo.status).toBe(400);
      expect((await issues(norepo)).map((i) => i.kind)).toContain('persona-without-repository');
      expect((await row('tt-ps'))?.requiresRepository).toBe(true);
    });

    it('refuses a step list edit that orphans an entry or names an entry-less id', async () => {
      await send('POST', '/admin/task-types', withStep());
      const orphan = await send('PATCH', '/admin/task-types/tt-ps', { stepIds: ['ta-a'] });
      expect(orphan.status).toBe(400);
      expect((await issues(orphan)).map((i) => i.kind)).toEqual(['prompt-step-orphan']);
      const missing = await send('PATCH', '/admin/task-types/tt-ps', {
        stepIds: ['ta-a', CUSTOM_ID, 'custom.tt-ps.second'],
      });
      expect(missing.status).toBe(400);
      expect((await issues(missing)).map((i) => i.kind)).toEqual(['prompt-step-missing']);
      const both = await send('PATCH', '/admin/task-types/tt-ps', {
        stepIds: ['ta-a', 'custom.tt-ps.second'],
        promptSteps: { second: step('second') },
      });
      expect(both.status).toBe(200);
      expect((await row('tt-ps'))?.stepIds).toEqual(['ta-a', 'custom.tt-ps.second']);
    });

    it('lets a step be removed together with its entry', async () => {
      await send('POST', '/admin/task-types', withStep());
      const res = await send('PATCH', '/admin/task-types/tt-ps', {
        stepIds: ['ta-a'],
        promptSteps: {},
      });
      expect(res.status).toBe(200);
      expect((await row('tt-ps'))?.promptSteps).toEqual({});
    });

    it('takes prompt steps on a custom row only', async () => {
      const body = { promptSteps: { review: step('review') } };
      const builtinRes = await send('PATCH', '/admin/task-types/workflow', body);
      expect(builtinRes.status).toBe(400);
      expect(((await builtinRes.json()) as { error: string }).error).toContain(
        'Cannot change promptSteps',
      );
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-mod',
        displayName: 'Mod',
        runListStrategy: 'static',
        stepIds: ['ta-a'],
        source: 'module:acme',
      });
      expect((await send('PATCH', '/admin/task-types/tt-mod', body)).status).toBe(400);
      expect((await row('workflow'))?.promptSteps).toEqual({});
      expect((await row('tt-mod'))?.promptSteps).toEqual({});
      const list = (await (await send('GET', '/admin/task-types')).json()) as {
        taskTypes: { slug: string; editableFields: string[] }[];
      };
      const editable = (slug: string) =>
        list.taskTypes.find((t) => t.slug === slug)?.editableFields;
      expect(editable('workflow')).not.toContain('promptSteps');
      expect(editable('tt-mod')).not.toContain('promptSteps');
      await send('POST', '/admin/task-types', valid('tt-adm'));
      const again = (await (await send('GET', '/admin/task-types/tt-adm')).json()) as {
        taskType: { editableFields: string[] };
      };
      expect(again.taskType.editableFields).toContain('promptSteps');
    });
  });
});
