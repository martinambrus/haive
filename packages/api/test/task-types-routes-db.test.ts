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
  catalogRow('ta-a', true, entry('ta-a', { provides: ['x'] })),
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
      .where(inArray(schema.taskTypeDefinitions.slug, ['workflow', 'plan_merge']));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.targetType, 'task_type'));
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
        200,
      );
      expect((await row('workflow'))?.enabled).toBe(false);
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
        requiresRepository: false,
        enabled: false,
        selectable: false,
      });
      expect(ok.status).toBe(200);
      expect(await row('tt-edit')).toMatchObject({
        stepIds: ['ta-a'],
        displayName: 'Edited',
        requiresRepository: false,
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
    const slugs = async () =>
      (
        (await (await send('GET', '/task-types')).json()) as { taskTypes: { slug: string }[] }
      ).taskTypes.map((t) => t.slug);

    it('shows a regular user what they may start, gated by the install switches', async () => {
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

      expect(await slugs()).toEqual(['workflow']);
      h.flags.set(CUSTOM_KEY, true);
      expect(await slugs()).toEqual(['tt-pub', 'workflow']);
      h.flags.set(MODULE_KEY, true);
      expect(await slugs()).toEqual(['tt-mod', 'tt-pub', 'workflow']);
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
});
