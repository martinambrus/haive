import { randomUUID } from 'node:crypto';
import { asc, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TASK_TYPES_API_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_types_api_test'))
  throw new Error('Use a dedicated task_types_api_test database for task type route tests');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  role: 'admin',
  flags: new Map<string, boolean>(),
  add: vi.fn(),
}));

vi.mock('../src/lib/sandbox-kill.js', async (original) => ({
  ...(await original<object>()),
  killTaskSandboxes: async () => 0,
}));
vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({ add: h.add }),
  getRepoQueue: () => ({ add: h.add }),
  getGlobalKbSyncQueue: () => ({ add: h.add }),
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
    getFresh: async () => 'normal',
    get: async () => 'true',
    getBoolean: async (key: string, fallback: boolean) => h.flags.get(key) ?? fallback,
  },
}));

import { stepRoutes } from '../src/routes/tasks/steps.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { Hono } from 'hono';
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import {
  DERIVED_CATALOG_LOCK_TIMEOUT_MS,
  readDerivedDefinition,
  moduleTaskDependency,
} from '@haive/shared/modularity-server';
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
app.route('/tasks', taskRoutes);
app.route('/tasks', stepRoutes);
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
      id: ACTOR,
      emailEncrypted: 'task-types-api-test@test.local',
      emailBlindIndex: USER_EMAIL_INDEX,
      passwordHash: randomUUID(),
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

    describe('the updatedAt precondition', () => {
      const MICROS = '2026-03-04 05:06:07.123956';
      const stamp = (slug: string, at = '2026-03-04 05:06:07.123') =>
        db.execute(sql`update task_type_definitions set updated_at = ${at} where slug = ${slug}`);
      const read = async (slug: string) =>
        (
          (await (await send('GET', `/admin/task-types/${slug}`)).json()) as {
            taskType: { updatedAt: string };
          }
        ).taskType;
      const created = async (slug: string, over: Record<string, unknown> = {}) => {
        expect((await send('POST', '/admin/task-types', valid(slug, over))).status).toBe(201);
        await stamp(slug);
        return read(slug);
      };

      it('refuses an edit made from a stale read with 409 and the current row, writing nothing', async () => {
        const seen = await created('tt-stale');
        const first = await send('PATCH', '/admin/task-types/tt-stale', {
          displayName: 'First',
          expectedUpdatedAt: seen.updatedAt,
        });
        expect(first.status).toBe(200);
        const afterFirst = await read('tt-stale');
        const second = await send('PATCH', '/admin/task-types/tt-stale', {
          displayName: 'Second',
          expectedUpdatedAt: seen.updatedAt,
        });
        expect(second.status).toBe(409);
        expect((await read('tt-stale')).updatedAt).toBe(afterFirst.updatedAt);
        const body = (await second.json()) as { error: string; code: string; taskType: unknown };
        expect(body.code).toBe('task_type_changed');
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.taskType).toEqual(await read('tt-stale'));
        expect(body.taskType).toMatchObject({ displayName: 'First' });
        expect((await row('tt-stale'))?.displayName).toBe('First');
        expect(await audits()).toEqual(['task_type.create:tt-stale', 'task_type.update:tt-stale']);
      });

      it('takes an edit made from the current read and moves updated_at forward', async () => {
        const seen = await created('tt-fresh');
        const res = await send('PATCH', '/admin/task-types/tt-fresh', {
          displayName: 'Fresh',
          expectedUpdatedAt: seen.updatedAt,
        });
        expect(res.status).toBe(200);
        const { taskType } = (await res.json()) as { taskType: { updatedAt: string } };
        expect(Date.parse(taskType.updatedAt)).toBeGreaterThan(Date.parse(seen.updatedAt));
        expect(taskType.updatedAt).toBe((await read('tt-fresh')).updatedAt);
        const next = await send('PATCH', '/admin/task-types/tt-fresh', {
          displayName: 'Again',
          expectedUpdatedAt: taskType.updatedAt,
        });
        expect(next.status).toBe(200);
      });

      it('still takes an edit that carries no precondition, whatever changed since', async () => {
        await created('tt-compat');
        expect(
          (await send('PATCH', '/admin/task-types/tt-compat', { displayName: 'One' })).status,
        ).toBe(200);
        expect(
          (await send('PATCH', '/admin/task-types/tt-compat', { displayName: 'Two' })).status,
        ).toBe(200);
        expect((await row('tt-compat'))?.displayName).toBe('Two');
      });

      it('compares to the millisecond, so a row stamped with microseconds matches a JS Date', async () => {
        await created('tt-us');
        await stamp('tt-us', MICROS);
        const seen = await read('tt-us');
        const [stored] = await db.execute(
          sql`select to_char(updated_at, 'US') as us from task_type_definitions where slug = 'tt-us'`,
        );
        expect(stored?.us).toBe('123956');
        expect(seen.updatedAt).toBe('2026-03-04T05:06:07.123Z');
        const instant = new Date(seen.updatedAt).toISOString();
        for (const off of ['2026-03-04T05:06:07.122Z', '2026-03-04T05:06:07.124Z']) {
          const res = await send('PATCH', '/admin/task-types/tt-us', {
            sortOrder: 1,
            expectedUpdatedAt: off,
          });
          expect(res.status).toBe(409);
        }
        expect((await row('tt-us'))?.sortOrder).toBe(0);
        const ok = await send('PATCH', '/admin/task-types/tt-us', {
          sortOrder: 3,
          expectedUpdatedAt: instant,
        });
        expect(ok.status).toBe(200);
        expect((await row('tt-us'))?.sortOrder).toBe(3);
        await stamp('tt-us', MICROS);
        const micros = await send('PATCH', '/admin/task-types/tt-us', {
          sortOrder: 4,
          expectedUpdatedAt: '2026-03-04T05:06:07.123956Z',
        });
        expect(micros.status).toBe(200);
      });

      it('lets exactly one of two edits from the same read through', async () => {
        const seen = await created('tt-race');
        const results = await Promise.all(
          ['A', 'B'].map((displayName) =>
            send('PATCH', '/admin/task-types/tt-race', {
              displayName,
              expectedUpdatedAt: seen.updatedAt,
            }),
          ),
        );
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const winner = results[0]!.status === 200 ? 'A' : 'B';
        expect((await row('tt-race'))?.displayName).toBe(winner);
      });

      it('applies to a built-in row, ahead of the field check, and after the 404', async () => {
        await stamp('workflow');
        const seen = await read('workflow');
        expect((await send('PATCH', '/admin/task-types/workflow', { sortOrder: 5 })).status).toBe(
          200,
        );
        const stale = await send('PATCH', '/admin/task-types/workflow', {
          sortOrder: 6,
          stepIds: ['ta-a'],
          expectedUpdatedAt: seen.updatedAt,
        });
        expect(stale.status).toBe(409);
        expect((await row('workflow'))?.sortOrder).toBe(5);
        const none = await send('PATCH', '/admin/task-types/tt-none', {
          displayName: 'x',
          expectedUpdatedAt: seen.updatedAt,
        });
        expect(none.status).toBe(404);
      });

      it('refuses a precondition that is not an ISO timestamp, writing nothing', async () => {
        const seen = await created('tt-bad-token');
        for (const bad of ['yesterday', '', 12, null]) {
          const res = await send('PATCH', '/admin/task-types/tt-bad-token', {
            displayName: 'Nope',
            expectedUpdatedAt: bad,
          });
          expect(res.status, JSON.stringify(bad)).toBe(400);
        }
        expect((await row('tt-bad-token'))?.displayName).toBe('Type tt-bad-token');
        expect((await read('tt-bad-token')).updatedAt).toBe(seen.updatedAt);
        const good = await send('PATCH', '/admin/task-types/tt-bad-token', {
          displayName: 'Yes',
          expectedUpdatedAt: seen.updatedAt,
        });
        expect(good.status).toBe(200);
      });
    });

    describe('a step removal that sends the step list alone', () => {
      const withFourth = () =>
        db
          .insert(schema.stepCatalog)
          .values(catalogRow('ta-d', true, entry('ta-d', { loopBudgetEditable: true })));
      const created = async () => {
        await withFourth();
        const res = await send(
          'POST',
          '/admin/task-types',
          valid('tt-prune', {
            stepIds: ['ta-a', 'ta-b', 'ta-d'],
            preAnswerDefaults: { 'ta-a': { depth: 1 }, 'ta-d': { depth: 2 } },
            stepLoopLimitDefaults: { 'ta-b': 3, 'ta-d': 2 },
          }),
        );
        expect(res.status).toBe(201);
      };
      const auditedFields = async () =>
        (
          await db
            .select()
            .from(schema.auditEvents)
            .where(eq(schema.auditEvents.action, 'task_type.update'))
            .orderBy(asc(schema.auditEvents.createdAt))
        )
          .map((e) => (e.metadata as { fields: string[] }).fields)
          .at(-1);

      it("drops the removed step's preset and loop limit, and keeps a concurrent edit to a retained step", async () => {
        await created();
        const other = await send('PATCH', '/admin/task-types/tt-prune', {
          preAnswerDefaults: { 'ta-a': { depth: 9 }, 'ta-d': { depth: 2 } },
          stepLoopLimitDefaults: { 'ta-b': 5, 'ta-d': 2 },
        });
        expect(other.status).toBe(200);
        const res = await send('PATCH', '/admin/task-types/tt-prune', {
          stepIds: ['ta-a', 'ta-b'],
        });
        expect(res.status).toBe(200);
        expect(await row('tt-prune')).toMatchObject({
          stepIds: ['ta-a', 'ta-b'],
          preAnswerDefaults: { 'ta-a': { depth: 9 } },
          stepLoopLimitDefaults: { 'ta-b': 5 },
        });
        expect(await auditedFields()).toEqual([
          'stepIds',
          'preAnswerDefaults',
          'stepLoopLimitDefaults',
        ]);
      });

      it('leaves the defaults alone when no step is removed', async () => {
        await created();
        const res = await send('PATCH', '/admin/task-types/tt-prune', {
          stepIds: ['ta-a', 'ta-d', 'ta-b'],
        });
        expect(res.status).toBe(200);
        expect(await row('tt-prune')).toMatchObject({
          stepIds: ['ta-a', 'ta-d', 'ta-b'],
          preAnswerDefaults: { 'ta-a': { depth: 1 }, 'ta-d': { depth: 2 } },
          stepLoopLimitDefaults: { 'ta-b': 3, 'ta-d': 2 },
        });
        expect(await auditedFields()).toEqual(['stepIds']);
      });

      it('still refuses a removal whose own request keeps a default for the removed step', async () => {
        await created();
        for (const field of ['preAnswerDefaults', 'stepLoopLimitDefaults']) {
          const res = await send('PATCH', '/admin/task-types/tt-prune', {
            stepIds: ['ta-a', 'ta-b'],
            [field]: { 'ta-d': field === 'preAnswerDefaults' ? { depth: 1 } : 1 },
          });
          expect(res.status).toBe(400);
          const { issues } = (await res.json()) as { issues: unknown[] };
          expect(issues).toContainEqual({
            kind: 'default-key-not-in-steps',
            field,
            stepId: 'ta-d',
          });
        }
        expect((await row('tt-prune'))?.stepIds).toEqual(['ta-a', 'ta-b', 'ta-d']);
      });
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
      ['integration-not-declared', { template: 'Say {{integration:x.account}}' }, {}],
      ['integration-property-unknown', { template: 'Say {{integration:x}}' }, {}],
      ['step-token-not-own-line', { template: 'Say {{step:ta-a}} now' }, {}],
      ['persona-id-invalid', { template: 'Be {{agent:Bad_Id}}' }, {}],
      ['persona-without-repository', { template: 'Be {{agent:reviewer}}' }, { repo: false }],
      [
        'file-write-without-repository',
        { template: 'Do it', capabilities: ['file_write'] },
        { repo: false },
      ],
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

    it('stores a step with valid tools on a create and on an edit', async () => {
      const created = await send(
        'POST',
        '/admin/task-types',
        withStep({ promptSteps: { review: step('review', { tools: [httpTool, ragTool] }) } }),
      );
      expect(created.status).toBe(201);
      const stored = (await row('tt-ps'))?.promptSteps as {
        review: { tools: { name: string; action: string }[] };
      };
      expect(stored.review.tools.map((t) => [t.name, t.action])).toEqual([
        ['repo_status', 'http-get'],
        ['house_rules', 'rag-query'],
      ]);
      const edited = await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: { review: step('review', { tools: [ragTool] }) },
      });
      expect(edited.status).toBe(200);
      const after = (await row('tt-ps'))?.promptSteps as { review: { tools: { name: string }[] } };
      expect(after.review.tools.map((t) => t.name)).toEqual(['house_rules']);
    });

    it('refuses a tool that fails its checks on a PATCH too, and leaves the stored step as it was', async () => {
      await send('POST', '/admin/task-types', withStep());
      const res = await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: {
          review: step('review', { tools: [{ ...httpTool, url: 'http://api.example.com/v1' }] }),
        },
      });
      expect(res.status).toBe(400);
      expect(await issues(res)).toEqual([
        expect.objectContaining({ kind: 'tool-url-not-https', stepId: CUSTOM_ID }),
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

    it('stores no invalidTools a client sends, on a create or on an edit', async () => {
      const forged = { ...step('review'), invalidTools: ['forged'] };
      const created = await send(
        'POST',
        '/admin/task-types',
        withStep({ promptSteps: { review: forged } }),
      );
      expect(created.status).toBe(201);
      expect((await row('tt-ps'))?.promptSteps).toEqual({
        review: { ...step('review'), capabilities: [], tools: [] },
      });
      const edited = await send('PATCH', '/admin/task-types/tt-ps', {
        promptSteps: { review: { ...forged, title: 'Edited' } },
      });
      expect(edited.status).toBe(200);
      expect(JSON.stringify((await row('tt-ps'))?.promptSteps)).not.toContain('invalidTools');
      expect(
        ((await row('tt-ps'))?.promptSteps as { review: { title: string } }).review.title,
      ).toBe('Edited');
    });

    it('reads a stored step whose tool no longer parses as present, and never writes the read copy back', async () => {
      const stored = {
        review: {
          ...step('review'),
          capabilities: [],
          tools: [{ ...httpTool, description: 'd'.repeat(1025) }],
        },
      };
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-bad-tool',
        displayName: 'Bad tool',
        runListStrategy: 'static',
        stepIds: ['ta-a', 'custom.tt-bad-tool.review'],
        promptSteps: stored,
        source: 'admin',
      });
      h.flags.set(CUSTOM_KEY, true);
      const detail = (await (await send('GET', '/admin/task-types/tt-bad-tool')).json()) as {
        availability: unknown;
        compositionIssues: unknown[];
      };
      expect(detail.availability).toEqual({ available: true });
      expect(detail.compositionIssues).toEqual([]);
      const renamed = await send('PATCH', '/admin/task-types/tt-bad-tool', {
        displayName: 'Renamed',
      });
      expect(renamed.status).toBe(200);
      expect((await row('tt-bad-tool'))?.promptSteps).toEqual(stored);
    });

    it('refuses an edit of the step list while a stored tool no longer passes its checks, and names the tool', async () => {
      const stored = {
        review: {
          ...step('review'),
          capabilities: [],
          tools: [{ ...httpTool, description: 'd'.repeat(1025) }],
        },
      };
      await db.insert(schema.taskTypeDefinitions).values({
        slug: 'tt-bad-tool',
        displayName: 'Bad tool',
        runListStrategy: 'static',
        stepIds: ['ta-a', 'custom.tt-bad-tool.review'],
        promptSteps: stored,
        source: 'admin',
      });
      h.flags.set(CUSTOM_KEY, true);
      const edited = await send('PATCH', '/admin/task-types/tt-bad-tool', {
        stepIds: ['ta-a', 'ta-b', 'custom.tt-bad-tool.review'],
      });
      expect(edited.status).toBe(400);
      expect(await issues(edited)).toEqual([
        expect.objectContaining({
          kind: 'tool-no-longer-valid',
          stepId: 'custom.tt-bad-tool.review',
          raw: 'repo_status',
        }),
      ]);
      expect((await row('tt-bad-tool'))?.promptSteps).toEqual(stored);
      expect((await row('tt-bad-tool'))?.stepIds).toEqual(['ta-a', 'custom.tt-bad-tool.review']);
    });
  });

  const derivedDraft = (changes: unknown[] = []) => ({
    slug: 'tt-derived',
    displayName: 'Derived',
    runListStrategy: 'derived',
    baseSlug: 'workflow',
    changes,
  });
  const derivedCatalog = async () => {
    const ids = [
      '00-model-health-workflow',
      '00a-sync-base',
      '00-triage',
      '01-worktree-setup',
      '06-run-config',
      '08a-browser-verify',
      '10-gate-3-commit',
    ];
    await db.delete(schema.stepCatalog);
    await db.insert(schema.stepCatalog).values([
      ...ids.map((id, stepIndex) => ({
        ...catalogRow(id, true, entry(id, { agentAuthoredOutput: true })),
        stepIndex,
      })),
      {
        ...catalogRow('module.acme.check', true, entry('module.acme.check'), 'module:acme'),
        workflowType: 'extra',
        stepIndex: 1,
      },
    ]);
    await db.insert(schema.modules).values({
      moduleId: 'acme',
      packageName: '@haive/module-acme',
      name: 'Acme',
      installedVersion: '1',
    });
    h.flags.set(CUSTOM_KEY, true);
  };
  it('previews and creates overlays, preserving deduped stale warnings and named replacement issues', async () => {
    await derivedCatalog();
    const draft = derivedDraft([{ remove: 'retired-step' }]);
    const preview = await send('POST', '/admin/task-types/preview', draft);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      warnings: [
        {
          operationIndex: 0,
          stepId: 'retired-step',
          candidates: [null, 'quick_bugfix', 'plan_tasklist', 'full_workflow'],
        },
      ],
      candidates: expect.any(Array),
    });
    expect(await row('tt-derived')).toBeUndefined();
    const created = await send('POST', '/admin/task-types', draft);
    expect(created.status).toBe(201);
    expect(await row('tt-derived')).toMatchObject({
      stepIds: null,
      baseSlug: 'workflow',
      changes: draft.changes,
      requiresRepository: true,
    });
    const invalid = await send(
      'POST',
      '/admin/task-types/preview',
      derivedDraft([{ replace: '10-gate-3-commit', with: '01-worktree-setup' }]),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ kind: 'replacement-contract-unavailable' }),
      ]),
    });
  });
  it('refuses a NULL catalog index by name on preview and task admission', async () => {
    await derivedCatalog();
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    await db
      .update(schema.stepCatalog)
      .set({ stepIndex: null })
      .where(eq(schema.stepCatalog.stepId, '01-worktree-setup'));
    const preview = await send('POST', '/admin/task-types/preview', derivedDraft());
    expect(preview.status).toBe(400);
    expect(await preview.json()).toMatchObject({
      issues: expect.arrayContaining([
        { kind: 'catalog-step-index-missing', stepId: '01-worktree-setup' },
      ]),
    });
    await expect(definitionForCreate(db, 'tt-derived', { generic: true })).rejects.toMatchObject({
      code: 'derived_admission_refused',
      issues: expect.arrayContaining([
        { kind: 'catalog-step-index-missing', stepId: '01-worktree-setup' },
      ]),
    });
  });
  it('pins candidates and raw prompts, uses union traits/defaults and ignores later definition edits', async () => {
    await derivedCatalog();
    const rawPrompt = {
      slug: 'note',
      title: 'Note',
      template: '{{step:08a-browser-verify}}',
      capabilities: [],
      tools: [],
      timeoutMs: 60_000,
      agentPool: '*',
    };
    const draft = {
      ...derivedDraft([{ insertAfter: '08a-browser-verify', step: 'custom.tt-derived.note' }]),
      promptSteps: { note: rawPrompt },
      preAnswerDefaults: { '06-run-config': { simplifyCode: false } },
    };
    expect((await send('POST', '/admin/task-types', draft)).status).toBe(201);
    const pinned = await definitionForCreate(db, 'tt-derived', { generic: true });
    expect(pinned.derivedRunPlan?.candidates).toHaveLength(4);
    expect(pinned.customSteps).toEqual({ 'custom.tt-derived.note': rawPrompt });
    expect(pinned.takesRootLock).toBe(true);
    expect(pinned.preAnswers).toEqual(draft.preAnswerDefaults);
    await db
      .update(schema.taskTypeDefinitions)
      .set({ changes: [{ remove: '08a-browser-verify' }] })
      .where(eq(schema.taskTypeDefinitions.slug, 'tt-derived'));
    expect(pinned.derivedRunPlan?.candidates[0]?.stepIds).toContain('custom.tt-derived.note');
    expect(pinned.derivedRunPlan?.overlay.changes).toEqual(draft.changes);
  });
  it('checks module dependencies on unselected pinned candidates and selected snapshots', async () => {
    await derivedCatalog();
    expect(
      (
        await send(
          'POST',
          '/admin/task-types',
          derivedDraft([{ insertAfter: '08a-browser-verify', step: 'module.acme.check' }]),
        )
      ).status,
    ).toBe(201);
    const pin = await definitionForCreate(db, 'tt-derived', { generic: true });
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: user!.id,
        type: 'tt-derived',
        title: 'Derived',
        runListSnapshot: ['00-triage'],
        derivedRunPlan: pin.derivedRunPlan,
      })
      .returning();
    const dependencies = () =>
      db.select({ id: schema.tasks.id }).from(schema.tasks).where(moduleTaskDependency('acme'));
    expect(await dependencies()).toContainEqual({ id: task!.id });
    await db
      .update(schema.tasks)
      .set({ executionPath: 'quick_bugfix', runListSnapshot: ['00-triage'] })
      .where(eq(schema.tasks.id, task!.id));
    expect(await dependencies()).not.toContainEqual({ id: task!.id });
    await db
      .update(schema.modules)
      .set({ deactivatedAt: new Date() })
      .where(eq(schema.modules.moduleId, 'acme'));
    await expect(definitionForCreate(db, 'tt-derived', { generic: true })).rejects.toMatchObject({
      code: 'module-deactivated',
    });
  });
  it('keeps authoring ownership and optimistic edit rules for derived definitions', async () => {
    await derivedCatalog();
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    for (const body of [
      { baseSlug: 'run_app' },
      { runListStrategy: 'static' },
      { stepIds: ['ta-a'] },
      { requiresRepository: false },
    ])
      expect((await send('PATCH', '/admin/task-types/tt-derived', body)).status).toBe(400);
    expect(
      (
        await send('PATCH', '/admin/task-types/tt-derived', {
          expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
          changes: [],
        })
      ).status,
    ).toBe(409);
    expect(
      (await send('PATCH', '/admin/task-types/tt-derived', { changes: [{ remove: 'old-step' }] }))
        .status,
    ).toBe(200);
    await taskFor('tt-derived');
    expect((await send('DELETE', '/admin/task-types/tt-derived')).status).toBe(409);
  });

  const waitForLock = async (fragment: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await db.execute(
        sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND strpos(query, ${fragment}) > 0`,
      );
      if (rows.length) return;
    }
    throw new Error('Expected a blocked SQL statement: ' + fragment);
  };
  it('serializes catalog upgrades with admission and pins the complete committed generation', async () => {
    await derivedCatalog();
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    const old = await definitionForCreate(db, 'tt-derived', { generic: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const upgrading = db.transaction(async (tx) => {
      await tx
        .update(schema.stepCatalog)
        .set({ title: 'new generation' })
        .where(eq(schema.stepCatalog.stepId, '01-worktree-setup'));
      acquired();
      await gate;
      await tx
        .insert(schema.stepCatalog)
        .values({ ...catalogRow('new-after-sync', true, entry('new-after-sync')), stepIndex: 99 });
    });
    await locked;
    const creating = definitionForCreate(db, 'tt-derived', { generic: true });
    try {
      await waitForLock('LOCK TABLE');
    } finally {
      release();
    }
    await upgrading;
    const fresh = await creating;
    expect(fresh.derivedRunPlan?.base.candidates[0]?.stepIds).toContain('new-after-sync');
    expect(old.derivedRunPlan?.base.candidates[0]?.stepIds).not.toContain('new-after-sync');
    expect(fresh.derivedRunPlan?.base.catalogFingerprint).not.toBe(
      old.derivedRunPlan?.base.catalogFingerprint,
    );
  });
  it.each(['PATCH', 'DELETE'])(
    'holds the derived definition through task INSERT against a concurrent %s',
    async (method) => {
      await derivedCatalog();
      expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.emailBlindIndex, USER_EMAIL_INDEX));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: () => void;
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      let snapshot: string[] | null = null;
      const creating = db.transaction(async (tx) => {
        const definition = await definitionForCreate(tx, 'tt-derived', {
          generic: true,
          locked: true,
        });
        snapshot = definition.runListSnapshot;
        acquired();
        await gate;
        await tx.insert(schema.tasks).values({
          userId: user!.id,
          type: 'tt-derived',
          title: 'race',
          runListSnapshot: definition.runListSnapshot,
          derivedRunPlan: definition.derivedRunPlan,
        });
      });
      await locked;
      const editing = send(
        method,
        '/admin/task-types/tt-derived',
        method === 'PATCH' ? { changes: [{ remove: '08a-browser-verify' }] } : undefined,
      );
      try {
        await waitForLock('task_type_definitions');
      } finally {
        release();
      }
      await creating;
      expect((await editing).status).toBe(method === 'PATCH' ? 200 : 409);
      const [stored] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.type, 'tt-derived'));
      expect(stored?.runListSnapshot).toEqual(snapshot);
      expect(stored?.runListSnapshot).toContain('08a-browser-verify');
    },
  );
  it('returns structured 409 from task POST with no task, event or queue job on refusal', async () => {
    await derivedCatalog();
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    await db
      .update(schema.taskTypeDefinitions)
      .set({ changes: [{ replace: '01-worktree-setup', with: '08a-browser-verify' }] })
      .where(eq(schema.taskTypeDefinitions.slug, 'tt-derived'));
    const before = await db.select({ id: schema.taskEvents.id }).from(schema.taskEvents);
    h.add.mockClear();
    const response = await send('POST', '/tasks', { type: 'tt-derived', title: 'refused' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'derived_admission_refused',
      issues: expect.arrayContaining([
        expect.objectContaining({ kind: 'replacement-contract-unavailable' }),
      ]),
    });
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.type, 'tt-derived'))).toEqual(
      [],
    );
    expect(await db.select({ id: schema.taskEvents.id }).from(schema.taskEvents)).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
  });
  it('rolls back derived create and PATCH when the transaction-required audit fails', async () => {
    await derivedCatalog();
    await db.execute(
      sql`CREATE FUNCTION derived_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('task_type.create', 'task_type.update') THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER derived_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION derived_audit_failure()`,
    );
    try {
      expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(500);
      expect(await row('tt-derived')).toBeUndefined();
      await db.execute(sql`ALTER TABLE audit_events DISABLE TRIGGER derived_audit_failure`);
      expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
      await db.execute(sql`ALTER TABLE audit_events ENABLE TRIGGER derived_audit_failure`);
      expect(
        (
          await send('PATCH', '/admin/task-types/tt-derived', {
            changes: [{ remove: '08a-browser-verify' }],
          })
        ).status,
      ).toBe(500);
      expect((await row('tt-derived'))?.changes).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER derived_audit_failure ON audit_events`);
      await db.execute(sql`DROP FUNCTION derived_audit_failure()`);
    }
  });
  it('preserves availability precedence before malformed derived catalog diagnostics', async () => {
    await derivedCatalog();
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    await db.delete(schema.stepCatalog);
    h.flags.set(CUSTOM_KEY, false);
    await expect(definitionForCreate(db, 'tt-derived', { generic: true })).rejects.toMatchObject({
      status: 403,
      message: 'Custom task types are disabled on this install',
    });
    await db
      .update(schema.taskTypeDefinitions)
      .set({ enabled: false })
      .where(eq(schema.taskTypeDefinitions.slug, 'tt-derived'));
    await expect(definitionForCreate(db, 'tt-derived', { generic: true })).rejects.toMatchObject({
      status: 403,
      message: 'Task type tt-derived is disabled',
    });
  });

  it('admits a derived task through POST, prunes obsolete defaults and pins historical diagnostics at INSERT', async () => {
    await derivedCatalog();
    expect(
      (await send('POST', '/admin/task-types', derivedDraft([{ remove: 'old-step' }]))).status,
    ).toBe(201);
    const listing = await send('GET', '/task-types');
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      taskTypes: expect.arrayContaining([
        expect.objectContaining({
          slug: 'tt-derived',
          available: true,
          warnings: [
            {
              kind: 'stale-target',
              operationIndex: 0,
              stepId: 'old-step',
              candidates: [null, 'quick_bugfix', 'plan_tasklist', 'full_workflow'],
            },
          ],
        }),
      ]),
    });
    await db
      .update(schema.taskTypeDefinitions)
      .set({ preAnswerDefaults: { 'retired-default': { decision: 'skip' } } })
      .where(eq(schema.taskTypeDefinitions.slug, 'tt-derived'));
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId: ACTOR,
        name: 'derived-create',
        source: 'local_path',
        localPath: '/tmp',
        storagePath: '/tmp',
        status: 'ready',
      })
      .returning();
    try {
      h.add.mockClear();
      const response = await send('POST', '/tasks', {
        type: 'tt-derived',
        title: 'accepted',
        repositoryId: repo!.id,
        stepLoopLimits: {},
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { task: { id: string }; warnings: unknown[] };
      expect(body.warnings).toEqual([
        {
          kind: 'stale-target',
          operationIndex: 0,
          stepId: 'old-step',
          candidates: [null, 'quick_bugfix', 'plan_tasklist', 'full_workflow'],
        },
        { kind: 'default-key-not-in-steps', field: 'preAnswerDefaults', stepId: 'retired-default' },
      ]);
      const [stored] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, body.task.id));
      expect(stored?.preAnswers).toEqual({});
      expect(stored?.derivedRunPlan).toMatchObject({
        version: 1,
        overlay: { changes: [{ remove: 'old-step' }] },
      });
      expect(stored?.runListSnapshot?.slice(0, 3)).toEqual([
        '00-model-health-workflow',
        '00a-sync-base',
        '00-triage',
      ]);
      expect(h.add).toHaveBeenCalledTimes(1);
      await db
        .update(schema.taskTypeDefinitions)
        .set({ changes: [] })
        .where(eq(schema.taskTypeDefinitions.slug, 'tt-derived'));
      const detail = await send('GET', '/tasks/' + body.task.id);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ warnings: body.warnings });
    } finally {
      await db.delete(schema.repositories).where(eq(schema.repositories.id, repo!.id));
    }
  });

  it.each(['admission', 'choice', 'grant', 'invocation'])(
    'counts retained %s integration dependencies only on chosen paths, preserving live bindings',
    async (kind) => {
      await derivedCatalog();
      expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
      const definition = await definitionForCreate(db, 'tt-derived', { generic: true });
      const plan = {
        ...definition.derivedRunPlan!,
        integrationAdmissions: [{ categoryId: 'forge', moduleId: 'acme' }],
        composableEntries: definition.derivedRunPlan!.composableEntries.map((entry) =>
          entry.stepId === '08a-browser-verify'
            ? {
                ...entry,
                integrations: [{ id: 'forge', category: 'forge', access: 'read' as const }],
              }
            : entry,
        ),
      };
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId: ACTOR,
          type: 'tt-derived',
          title: 'Integration dependency',
          derivedRunPlan: plan,
          runListSnapshot: definition.runListSnapshot,
        })
        .returning();
      const [connection] = await db
        .insert(schema.integrationConnections)
        .values({
          providerId: 'module.acme.forge',
          scope: 'user',
          ownerUserId: ACTOR,
          accountLabel: 'Fixture',
          authMethod: 'oauth',
        })
        .returning();
      try {
        if (kind === 'admission')
          await db
            .insert(schema.moduleTaskAdmissions)
            .values({ taskId: task!.id, moduleId: 'acme' });
        if (kind === 'choice')
          await db.insert(schema.taskIntegrationChoices).values({
            taskId: task!.id,
            categoryId: 'forge',
            providerId: 'module.acme.forge',
            connectionId: connection!.id,
          });
        if (kind === 'grant')
          await db.insert(schema.integrationGrants).values({
            taskId: task!.id,
            categoryId: 'forge',
            connectionId: connection!.id,
            targetKind: 'task',
          });
        if (kind === 'invocation')
          await db.insert(schema.cliInvocations).values({
            taskId: task!.id,
            mode: 'cli',
            prompt: 'fixture',
            integrations: [
              {
                requirementId: 'forge',
                categoryId: 'forge',
                providerId: 'module.acme.forge',
                connectionId: connection!.id,
                access: 'read',
              },
            ],
          });
        const depends = async () =>
          (
            await db
              .select({ id: schema.tasks.id })
              .from(schema.tasks)
              .where(moduleTaskDependency('acme'))
          ).some((row) => row.id === task!.id);
        expect(await depends()).toBe(true);
        const quick = plan.candidates.find(
          (candidate) => candidate.executionPath === 'quick_bugfix',
        )!.stepIds;
        await db
          .update(schema.tasks)
          .set({ executionPath: 'quick_bugfix', runListSnapshot: [...quick] })
          .where(eq(schema.tasks.id, task!.id));
        expect(await depends()).toBe(kind === 'invocation');
        await db
          .update(schema.tasks)
          .set({ executionPath: 'full_workflow', runListSnapshot: definition.runListSnapshot })
          .where(eq(schema.tasks.id, task!.id));
        expect(await depends()).toBe(true);
      } finally {
        await db
          .delete(schema.integrationConnections)
          .where(eq(schema.integrationConnections.id, connection!.id));
      }
    },
  );

  it('refuses Skip before selection and rejects changing a selected path in the submit transaction', async () => {
    await derivedCatalog();
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    const definition = await definitionForCreate(db, 'tt-derived', { generic: true });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: ACTOR,
        type: 'tt-derived',
        title: 'Triage',
        status: 'running',
        currentStepId: '00-triage',
        derivedRunPlan: definition.derivedRunPlan,
        runListSnapshot: definition.runListSnapshot,
      })
      .returning();
    const marker = new Date();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '00-triage',
        stepIndex: 2,
        title: 'Triage',
        status: 'waiting_form',
        round: 0,
        waitingStartedAt: marker,
      })
      .returning();
    // Even a catalog opting into Skip cannot bypass the derived path guard.
    await db
      .update(schema.stepCatalog)
      .set({ allowSkip: true })
      .where(eq(schema.stepCatalog.stepId, '00-triage'));
    h.add.mockClear();
    const skipped = await send('POST', `/tasks/${task!.id}/steps/00-triage/action`, {
      action: 'skip',
    });
    expect(skipped.status).toBe(409);
    expect(await skipped.json()).toMatchObject({ code: 'derived_path_unselected' });
    await db
      .update(schema.tasks)
      .set({
        executionPath: 'quick_bugfix',
        runListSnapshot: [
          ...definition.derivedRunPlan!.candidates.find((c) => c.executionPath === 'quick_bugfix')!
            .stepIds,
        ],
      })
      .where(eq(schema.tasks.id, task!.id));
    const changed = await send('POST', `/tasks/${task!.id}/steps/00-triage/submit`, {
      values: { path: 'full_workflow', broadAudit: true },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'derived_path_pinned' });
    const [held] = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, step!.id));
    expect(held).toMatchObject({
      status: 'waiting_form',
      waitingStartedAt: marker,
      formValues: null,
    });
    expect(h.add).not.toHaveBeenCalled();
  });
  it.each(['/admin/task-types/preview', '/admin/task-types'])(
    'warns about off-path replacements on a refused save at %s',
    async (path) => {
      await derivedCatalog();
      const response = await send(
        'POST',
        path,
        derivedDraft([{ replace: '08a-browser-verify', with: '01-worktree-setup' }]),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        warnings: [
          {
            kind: 'path-absent-replacement',
            operationIndex: 0,
            stepId: '08a-browser-verify',
            candidates: ['quick_bugfix', 'plan_tasklist'],
          },
        ],
      });
    },
  );
  it('bounds catalog lock waits with a named issue and restores the caller lock policy on success', async () => {
    await derivedCatalog();
    expect(DERIVED_CATALOG_LOCK_TIMEOUT_MS).toBe(1_000);
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    const definition = (await row('tt-derived'))!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const syncing = db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE step_catalog IN ROW EXCLUSIVE MODE`);
      acquired();
      await gate;
    });
    await locked;
    try {
      await expect(
        db.transaction((tx) =>
          readDerivedDefinition(tx, definition, undefined, { lockTimeoutMs: 5 }),
        ),
      ).rejects.toMatchObject({
        code: 'derived_admission_refused',
        issues: [{ kind: 'catalog-busy' }],
      });
    } finally {
      release();
      await syncing;
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '17ms'`);
      await readDerivedDefinition(tx, definition);
      const [setting] = await tx.execute<{ timeout: string }>(
        sql`SELECT current_setting('lock_timeout') AS timeout`,
      );
      expect(setting!.timeout).toBe('17ms');
    });
  });
  it('publishes ordered base paths and derived saved-database traits from the candidate union', async () => {
    await derivedCatalog();
    await db.insert(schema.stepCatalog).values({
      ...catalogRow('01c1-restore-database', true, entry('01c1-restore-database')),
      stepIndex: 99,
    });
    expect((await send('POST', '/admin/task-types', derivedDraft())).status).toBe(201);
    const catalog = await send('GET', '/admin/task-types/catalog');
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      bases: expect.arrayContaining([
        expect.objectContaining({
          slug: 'workflow',
          orderedBaseLists: expect.arrayContaining([
            expect.objectContaining({
              executionPath: 'quick_bugfix',
              stepIds: expect.arrayContaining(['01c1-restore-database']),
            }),
          ]),
        }),
      ]),
    });
    const listing = await send('GET', '/task-types');
    expect(await listing.json()).toMatchObject({
      taskTypes: expect.arrayContaining([
        expect.objectContaining({ slug: 'tt-derived', restoresDatabase: true }),
      ]),
    });
  });
});
