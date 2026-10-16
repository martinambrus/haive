import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TASK_CREATE_PATH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_create_path_test'))
  throw new Error('Use a dedicated task_create_path_test database for create path tests');

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000e1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  gdb: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  beforeQueued: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({
  getTaskQueue: () => ({ add: h.add }),
  getGlobalKbSyncQueue: () => ({ add: vi.fn() }),
}));
vi.mock('../src/lib/task-start.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/task-start.js')>();
  return {
    ...actual,
    markQueuedForStart: async (...args: Parameters<typeof actual.markQueuedForStart>) => {
      await h.beforeQueued?.();
      return actual.markQueuedForStart(...args);
    },
  };
});
vi.mock('../src/lib/plan-mirror.js', () => ({
  enqueuePlanMirrorRefresh: vi.fn(),
  pullPlanMirror: vi.fn(),
  savePlanMirror: vi.fn(),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    getBoolean: async () => true,
    get: async () => 'true',
    getFresh: async () => 'normal',
  },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb, settings: { namespace: 'default' } }),
}));

import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createDatabase,
  isLockNotAvailable,
  lockRepositoryRow,
  lockRepositoryTasksKey,
  schema,
  type Database,
  type DbTx,
} from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES } from '@haive/shared';
import { globalKbEntries } from '@haive/shared/global-kb';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { globalKbRoutes } from '../src/routes/global-kb.js';
import { planRoutes } from '../src/routes/plan.js';
import { spawnPlanTask } from '../src/lib/spawn-plan-task.js';
import { loadLiveRootWriters } from '../src/routes/repos.js';
import { definitionForCreate } from '../src/lib/task-type-definition.js';
import { markQueuedForStart } from '../src/lib/task-start.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000e2';
const CANARY = '00-model-health-workflow';
const LOCK_STEP = '01-worktree-setup';
const SLUGS = [
  'cp-cli',
  'cp-plain',
  'cp-simplify',
  'cp-lock',
  'cp-defaults',
  'cp-repo',
  'cp-norepo',
  'cp-sync',
  'cp-pin',
  'cp-restore',
  'cp-invalid',
  'cp-missing',
  'cp-new-norepo',
  'cp-new-wt',
];
const STEP_IDS = [
  'cp-cli',
  'cp-plain',
  'cp-needs',
  LOCK_STEP,
  '00a-sync-base',
  '07a-code-simplify',
  '01c1-restore-database',
  '11g-save-database',
  'cp-b-1',
  'cp-b-2',
];

const entry = (stepId: string, over: Record<string, unknown> = {}) => ({
  stepId,
  label: stepId,
  group: 'build',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...over,
});

const catalogRow = (stepId: string, dispatchesCli = false) => ({
  stepId,
  source: 'core',
  title: stepId,
  workflowType: 'workflow',
  dispatchesCli,
  allowSkip: false,
  providerSensitive: false,
  composable: true,
  entry: entry(
    stepId,
    stepId === 'cp-needs'
      ? { requires: [{ needs: 'nothing-provides-this', reason: 'x' }] }
      : stepId === LOCK_STEP
        ? { requires: [{ needs: 'repository', reason: 'Needs a repository.' }] }
        : {},
  ),
});

const typeRow = (
  slug: string,
  stepIds: string[],
  over: Partial<typeof schema.taskTypeDefinitions.$inferInsert> = {},
) => ({
  slug,
  displayName: slug,
  runListStrategy: 'static' as const,
  stepIds,
  source: 'admin',
  requiresRepository: true,
  ...over,
});

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/admin/task-types', adminTaskTypeRoutes);
app.route('/repositories', planRoutes);
app.route('/global-kb', globalKbRoutes);
app.onError(errorHandler);

const post = (body: Record<string, unknown>) =>
  app.request('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 't', description: 'do it', ...body }),
  });

describe.skipIf(!url)('POST /tasks create path on Postgres', () => {
  let db: Database;

  const created = async (res: Response) => {
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { id: string } };
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    const [pin] = await db
      .select()
      .from(schema.taskDatabaseStates)
      .where(eq(schema.taskDatabaseStates.taskId, task.id));
    return { row: row!, pinned: pin !== undefined };
  };

  const claimRoot = (on: boolean) =>
    db
      .update(schema.repositories)
      .set({ rootClaimedAt: on ? new Date() : null, rootClaimKind: on ? 'reset' : null })
      .where(eq(schema.repositories.id, REPO));

  const clean = async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(
        inArray(schema.taskTypeDefinitions.slug, [
          ...SLUGS,
          'onboarding',
          'workflow',
          'run_app',
          'kb_author',
        ]),
      );
    await db.delete(schema.stepCatalog).where(inArray(schema.stepCatalog.stepId, STEP_IDS));
  };

  afterAll(async () => {
    await clean();
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    db ??= createDatabase(url as string);
    h.db = db;
    await clean();
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'x',
      emailBlindIndex: 'create-path-test',
      passwordHash: 'x',
    });
    await db
      .insert(schema.repositories)
      .values({ id: REPO, userId: USER, name: 'repo', source: 'local_path', localPath: '/tmp/x' });
    await db
      .insert(schema.stepCatalog)
      .values(STEP_IDS.map((id) => catalogRow(id, id === 'cp-cli')));
    await db.insert(schema.taskTypeDefinitions).values([
      typeRow('cp-cli', ['cp-cli']),
      typeRow('cp-plain', ['cp-plain']),
      typeRow('cp-simplify', ['cp-plain', '07a-code-simplify']),
      typeRow('cp-lock', [LOCK_STEP, 'cp-plain']),
      typeRow('cp-defaults', ['cp-plain'], {
        preAnswerDefaults: { 'cp-plain': { a: 1, b: 2 } },
        stepLoopLimitDefaults: { 'cp-plain': 3, 'cp-cli': 4 },
      }),
      typeRow('cp-repo', ['cp-plain'], { requiresRepository: true }),
      typeRow('cp-norepo', ['cp-plain'], { requiresRepository: false }),
      typeRow('cp-sync', ['00a-sync-base', 'cp-plain']),
      typeRow('cp-pin', ['cp-plain', '11g-save-database']),
      typeRow('cp-restore', ['01c1-restore-database']),
      typeRow('cp-invalid', ['cp-needs']),
      typeRow('cp-missing', ['cp-plain', 'cp-not-in-catalog']),
    ]);
  });

  it('prepends the model-health canary to a custom type that dispatches a CLI', async () => {
    const { row } = await created(await post({ type: 'cp-cli', repositoryId: REPO }));
    expect(row.runListSnapshot).toEqual([CANARY, 'cp-cli']);
  });

  it('adds no canary to a custom type with no CLI step', async () => {
    const { row } = await created(await post({ type: 'cp-plain', repositoryId: REPO }));
    expect(row.runListSnapshot).toEqual(['cp-plain']);
  });

  it('adds no canary to a built-in, whatever its steps do', async () => {
    await db.insert(schema.taskTypeDefinitions).values([
      typeRow('onboarding', ['cp-cli'], { source: 'builtin' }),
      typeRow('workflow', [], {
        source: 'builtin',
        runListStrategy: 'workflow_paths',
        stepIds: null,
      }),
    ]);
    const onboarding = await created(await post({ type: 'onboarding', repositoryId: REPO }));
    expect(onboarding.row.runListSnapshot).toEqual(['cp-cli']);
    const workflow = await created(await post({ type: 'workflow', repositoryId: REPO }));
    expect(workflow.row.runListSnapshot).toBeNull();
  });

  it('turns simplify_code on when a custom type has 07a-code-simplify, and only then', async () => {
    expect(
      (await created(await post({ type: 'cp-simplify', repositoryId: REPO }))).row,
    ).toMatchObject({ simplifyCode: true });
    expect((await created(await post({ type: 'cp-plain', repositoryId: REPO }))).row).toMatchObject(
      { simplifyCode: false },
    );
  });

  it('takes the repository root lock only when the snapshot has 01-worktree-setup', async () => {
    await claimRoot(true);
    expect((await post({ type: 'cp-lock', repositoryId: REPO })).status).toBe(409);
    expect((await post({ type: 'cp-plain', repositoryId: REPO })).status).toBe(201);
    expect((await post({ type: 'cp-sync', repositoryId: REPO })).status).toBe(409);
  });

  it('counts a live custom task with 01-worktree-setup as a root writer, and not one without', async () => {
    await created(await post({ type: 'cp-plain', repositoryId: REPO }));
    expect(await loadLiveRootWriters(db, USER, REPO)).toEqual([]);
    const { row } = await created(await post({ type: 'cp-lock', repositoryId: REPO }));
    expect(await loadLiveRootWriters(db, USER, REPO)).toEqual([{ id: row.id }]);
  });

  it('copies the type defaults into the task, and the request wins', async () => {
    const plain = await created(await post({ type: 'cp-defaults', repositoryId: REPO }));
    expect(plain.row.preAnswers).toEqual({ 'cp-plain': { a: 1, b: 2 } });
    expect(plain.row.stepLoopLimits).toEqual({ 'cp-plain': 3, 'cp-cli': 4 });
    const own = await created(
      await post({
        type: 'cp-defaults',
        repositoryId: REPO,
        stepLoopLimits: { 'cp-plain': 9 },
      }),
    );
    expect(own.row.stepLoopLimits).toEqual({ 'cp-plain': 9, 'cp-cli': 4 });
  });

  it('refuses a type that requires a repository when the request names none', async () => {
    expect((await post({ type: 'cp-repo' })).status).toBe(400);
    expect((await post({ type: 'cp-repo', repositoryId: REPO })).status).toBe(201);
  });

  it('creates a repo-less custom task with the anchor recorded as null, and anchors it when a repository is named', async () => {
    const none = await created(await post({ type: 'cp-norepo' }));
    expect(none.row.repositoryId).toBeNull();
    expect(none.row.metadata).toEqual({ anchorRepositoryId: null });
    const anchored = await created(await post({ type: 'cp-norepo', repositoryId: REPO }));
    expect(anchored.row.repositoryId).toBe(REPO);
    expect(anchored.row.metadata).toEqual({ anchorRepositoryId: REPO });
  });

  it('records no anchor on a task of a type that requires a repository', async () => {
    const { row } = await created(await post({ type: 'cp-repo', repositoryId: REPO }));
    expect(row.metadata).toBeNull();
  });

  it('records no anchor on an unseeded built-in that is given a repository', async () => {
    const withRepo = await created(await post({ type: 'workflow', repositoryId: REPO }));
    expect(withRepo.row.metadata).toBeNull();
  });

  const taskCount = async () =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.userId, USER))).length;

  it('refuses a seeded built-in that requires a repository when the request names none', async () => {
    await db.insert(schema.taskTypeDefinitions).values([
      typeRow('onboarding', ['cp-b-1'], { source: 'builtin' }),
      typeRow('workflow', [], {
        source: 'builtin',
        runListStrategy: 'workflow_paths',
        stepIds: null,
      }),
      typeRow('run_app', [], {
        source: 'builtin',
        runListStrategy: 'run_app_modes',
        stepIds: null,
      }),
    ]);
    for (const type of ['onboarding', 'workflow', 'run_app']) {
      expect((await post({ type })).status).toBe(400);
    }
    expect(await taskCount()).toBe(0);
  });

  it('refuses an unseeded built-in that requires a repository when the request names none', async () => {
    expect((await post({ type: 'workflow' })).status).toBe(400);
    expect(await taskCount()).toBe(0);
  });

  it('does not refuse a repo-optional built-in for lacking a repository', async () => {
    await db
      .insert(schema.taskTypeDefinitions)
      .values(
        typeRow('onboarding', ['cp-plain'], { source: 'builtin', requiresRepository: false }),
      );
    expect((await post({ type: 'onboarding' })).status).toBe(201);
    expect(await definitionForCreate(db, 'kb_author', { generic: false })).toMatchObject({
      requiresRepository: false,
    });
    await db
      .insert(schema.taskTypeDefinitions)
      .values(typeRow('kb_author', ['cp-plain'], { source: 'builtin', requiresRepository: false }));
    expect(await definitionForCreate(db, 'kb_author', { generic: false })).toMatchObject({
      requiresRepository: false,
      repoOptional: true,
    });
  });

  it('accepts a saved database only for a custom type that restores one', async () => {
    const snapshot = { databaseSnapshotId: '00000000-0000-4000-8000-0000000000dd' };
    expect((await post({ type: 'cp-pin', repositoryId: REPO, ...snapshot })).status).toBe(400);
    expect((await post({ type: 'cp-restore', repositoryId: REPO, ...snapshot })).status).not.toBe(
      400,
    );
  });

  it('pins a database for a custom type with 01c1-restore-database or 11g-save-database', async () => {
    for (const type of ['cp-pin', 'cp-restore']) {
      expect((await created(await post({ type, repositoryId: REPO }))).pinned).toBe(true);
    }
    expect((await created(await post({ type: 'cp-plain', repositoryId: REPO }))).pinned).toBe(
      false,
    );
  });

  it('is a 409 naming the reason for an invalid composition or a step the catalog lacks', async () => {
    const invalid = await post({ type: 'cp-invalid', repositoryId: REPO });
    expect([invalid.status, ((await invalid.json()) as { code: string }).code]).toEqual([
      409,
      'invalid-composition',
    ]);
    const missing = await post({ type: 'cp-missing', repositoryId: REPO });
    const body = (await missing.json()) as { code: string; error: string };
    expect([missing.status, body.code]).toEqual([409, 'missing-step']);
    expect(body.error).toContain('cp-not-in-catalog');
  });

  it('creates a task of a built-in type exactly as before', async () => {
    await db.insert(schema.taskTypeDefinitions).values([
      typeRow('onboarding', ['cp-b-1', 'cp-b-2'], { source: 'builtin', requiresRepository: true }),
      typeRow('workflow', [], {
        source: 'builtin',
        runListStrategy: 'workflow_paths',
        stepIds: null,
        requiresRepository: true,
      }),
      typeRow('run_app', [], {
        source: 'builtin',
        runListStrategy: 'run_app_modes',
        stepIds: null,
        requiresRepository: true,
      }),
    ]);
    const seen: Record<string, unknown> = {};
    for (const type of ['onboarding', 'workflow', 'run_app']) {
      for (const simplifyCode of [undefined, true]) {
        const { row, pinned } = await created(
          await post({ type, repositoryId: REPO, simplifyCode }),
        );
        await db
          .update(schema.tasks)
          .set({ status: 'cancelled' })
          .where(eq(schema.tasks.id, row.id));
        await claimRoot(true);
        const locked = (await post({ type, repositoryId: REPO, simplifyCode })).status === 409;
        await claimRoot(false);
        seen[`${type}/${String(simplifyCode)}`] = {
          snapshot: row.runListSnapshot,
          simplifyCode: row.simplifyCode,
          preAnswers: row.preAnswers,
          stepLoopLimits: row.stepLoopLimits,
          pinned,
          locked,
        };
        await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
      }
    }
    const none = { preAnswers: null, stepLoopLimits: {} };
    expect(seen).toEqual({
      'onboarding/undefined': {
        ...none,
        snapshot: ['cp-b-1', 'cp-b-2'],
        simplifyCode: false,
        pinned: false,
        locked: true,
      },
      'onboarding/true': {
        ...none,
        snapshot: ['cp-b-1', 'cp-b-2'],
        simplifyCode: true,
        pinned: false,
        locked: true,
      },
      'workflow/undefined': {
        ...none,
        snapshot: null,
        simplifyCode: false,
        pinned: true,
        locked: true,
      },
      'workflow/true': { ...none, snapshot: null, simplifyCode: true, pinned: true, locked: true },
      'run_app/undefined': {
        ...none,
        snapshot: null,
        simplifyCode: false,
        pinned: true,
        locked: false,
      },
      'run_app/true': { ...none, snapshot: null, simplifyCode: true, pinned: true, locked: false },
    });
  });

  describe('a task starting beside a checkout move', () => {
    const newTask = async () => {
      const [row] = await db
        .insert(schema.tasks)
        .values({ userId: USER, repositoryId: REPO, type: 'plan_build', title: 't' })
        .returning();
      return row!;
    };
    const statusOf = async (id: string) =>
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]?.status;

    /** A checkout move: a transaction holding REPO's task-creation lock until it is released. */
    const move = async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let taken!: () => void;
      const locked = new Promise<void>((resolve) => (taken = resolve));
      const done = db.transaction(async (tx) => {
        await lockRepositoryTasksKey(tx, REPO);
        taken();
        await gate;
      });
      await Promise.race([locked, done]);
      return { release, done };
    };

    const requestWaiting = async () => {
      for (let i = 0; i < 100; i++) {
        const [row] = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
        );
        if (row!.n > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };

    it('queues a created task only once the move holding the repository lock ends', async () => {
      const task = await newTask();
      const moving = await move();
      const start = markQueuedForStart(db, task.id);
      try {
        expect(await requestWaiting()).toBe(true);
        expect(await statusOf(task.id)).toBe('created');
      } finally {
        moving.release();
        await moving.done;
      }
      expect(await start).toMatchObject({ status: 'queued' });
      expect(await statusOf(task.id)).toBe('queued');
    });

    it('keeps the lock until the transaction it runs in commits', async () => {
      const task = await newTask();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let queued!: () => void;
      const reached = new Promise<void>((resolve) => (queued = resolve));
      const creating = db.transaction(async (tx) => {
        await markQueuedForStart(tx, task.id);
        queued();
        await gate;
      });
      try {
        await Promise.race([reached, creating]);
        const free = await db
          .transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
            await lockRepositoryTasksKey(tx, REPO);
          })
          .then(
            () => true,
            (err: unknown) => {
              if (isLockNotAvailable(err)) return false;
              throw err;
            },
          );
        expect(free).toBe(false);
        expect(await statusOf(task.id)).toBe('created');
      } finally {
        release();
        await creating;
      }
      expect(await statusOf(task.id)).toBe('queued');
    });

    it('holds a task created through POST /tasks until the move ends, then queues it', async () => {
      const moving = await move();
      const request = post({ type: 'cp-plain', repositoryId: REPO });
      try {
        expect(await requestWaiting()).toBe(true);
        expect(await db.select().from(schema.tasks).where(eq(schema.tasks.userId, USER))).toEqual(
          [],
        );
      } finally {
        moving.release();
        await moving.done;
        await request;
      }
      const { row } = await created(await request);
      expect(row.status).toBe('queued');
    });
  });

  describe('a create beside another holder of the repository lock', () => {
    const locksOn = async (locktype: string, granted: boolean) => {
      const [row] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_locks where locktype = ${locktype} and granted = ${granted} and database = (select oid from pg_database where datname = current_database())`,
      );
      return row!.n;
    };
    const until = async (cond: () => Promise<boolean>) => {
      for (let i = 0; i < 200; i++) {
        if (await cond()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    };
    /** A transaction that takes what `hold` takes and keeps it until released. */
    const holding = async (hold: (tx: DbTx) => Promise<unknown>) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let taken!: () => void;
      const held = new Promise<void>((resolve) => (taken = resolve));
      const done = db.transaction(async (tx) => {
        await hold(tx);
        taken();
        await gate;
      });
      await Promise.race([held, done]);
      return { release, done };
    };

    it('never deadlocks a creation that takes the lock and then the repository row', async () => {
      const paused = await holding((tx) => tx.execute(sql`lock table task_events in share mode`));
      const pending: Promise<unknown>[] = [];
      try {
        pending.push(Promise.resolve(post({ type: 'cp-plain', repositoryId: REPO })));
        expect(await until(async () => (await locksOn('relation', false)) > 0)).toBe(true);
        pending.push(db.transaction(async (tx) => void (await lockRepositoryRow(tx, REPO))));
        expect(await until(async () => (await locksOn('advisory', false)) > 0)).toBe(true);
      } finally {
        paused.release();
        await paused.done;
        await Promise.allSettled(pending);
      }
      const [create, revival] = await Promise.allSettled(pending);
      expect(revival!.status).toBe('fulfilled');
      expect(create!.status === 'fulfilled' && (create!.value as Response).status).toBe(201);
    });

    it('never deadlocks a create that pins a database against one that holds the lock first', async () => {
      await db.insert(schema.taskTypeDefinitions).values([
        typeRow('workflow', [], {
          source: 'builtin',
          runListStrategy: 'workflow_paths',
          stepIds: null,
          requiresRepository: true,
        }),
        typeRow('run_app', [], {
          source: 'builtin',
          runListStrategy: 'run_app_modes',
          stepIds: null,
          requiresRepository: true,
        }),
      ]);
      const paused = await holding((tx) =>
        tx.execute(sql`select 1 from repositories where id = ${REPO} for no key update`),
      );
      const pending: Promise<Response>[] = [];
      try {
        pending.push(Promise.resolve(post({ type: 'workflow', repositoryId: REPO })));
        expect(await until(async () => (await locksOn('advisory', true)) > 0)).toBe(true);
        pending.push(Promise.resolve(post({ type: 'run_app', repositoryId: REPO })));
        expect(await until(async () => (await locksOn('advisory', false)) > 0)).toBe(true);
      } finally {
        paused.release();
        await paused.done;
        await Promise.allSettled(pending);
      }
      const statuses = await Promise.all(pending.map(async (p) => (await p).status));
      expect(statuses).toEqual([201, 201]);
    });
  });

  describe('admin task type routes', () => {
    const adminPost = (body: Record<string, unknown>) =>
      app.request('/admin/task-types', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'New', ...body }),
      });
    const adminPatch = (slug: string, body: Record<string, unknown>) =>
      app.request(`/admin/task-types/${slug}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const issuesOf = async (res: Response) =>
      ((await res.json()) as { issues: { kind: string; needs?: string }[] }).issues;

    it('creates a type that needs no repository', async () => {
      const res = await adminPost({
        slug: 'cp-new-norepo',
        stepIds: ['cp-plain'],
        requiresRepository: false,
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ taskType: { requiresRepository: false } });
    });

    it('refuses a repo-less type holding a step that needs a repository', async () => {
      const res = await adminPost({
        slug: 'cp-new-wt',
        stepIds: [LOCK_STEP],
        requiresRepository: false,
      });
      expect(res.status).toBe(400);
      expect(await issuesOf(res)).toMatchObject([{ kind: 'unmet-need', needs: 'repository' }]);
    });

    it('re-checks the composition when only requiresRepository is flipped to false', async () => {
      const res = await adminPatch('cp-lock', { requiresRepository: false });
      expect(res.status).toBe(400);
      expect(await issuesOf(res)).toMatchObject([{ kind: 'unmet-need', needs: 'repository' }]);
      const [row] = await db
        .select()
        .from(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.slug, 'cp-lock'));
      expect(row?.requiresRepository).toBe(true);
    });

    it('lets the flag flip on a type whose steps need no repository', async () => {
      const res = await adminPatch('cp-plain', { requiresRepository: false });
      expect(res.status).toBe(200);
    });
  });
});

describe.skipIf(!url)('plan and knowledge-base task creation on Postgres', () => {
  const CLI = '00000000-0000-4000-8000-0000000000e3';
  const NODE = '00000000-0000-4000-8000-0000000000e4';
  let db: Database;
  let observer: Database;
  const seen: string[][] = [];
  const atStart: { statuses: string[]; messages: number }[] = [];

  // A second connection, which sees only what has committed.
  const statuses = async () =>
    (
      await observer
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.userId, USER))
    ).map((row) => row.status);
  const messages = async () => (await observer.select().from(schema.planNodeMessages)).length;
  const sample = async () => void seen.push(await statuses());
  const neverCreated = () => {
    expect(seen).not.toHaveLength(0);
    expect(seen.flat()).not.toContain('created');
  };
  const choices = (taskId: string) =>
    db.select().from(schema.taskStepCliChoices).where(eq(schema.taskStepCliChoices.taskId, taskId));
  const send = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const spawn = (over: Partial<Parameters<typeof spawnPlanTask>[0]> = {}) =>
    spawnPlanTask({
      userId: USER,
      repositoryId: REPO,
      type: 'plan_chat',
      title: 'chat',
      metadata: {},
      cliProviderId: null,
      ...over,
    });

  beforeAll(() => {
    db = createDatabase(url as string);
    observer = createDatabase(url as string);
  });

  beforeEach(async () => {
    h.db = db;
    h.beforeQueued = sample;
    h.add.mockReset();
    h.add.mockImplementation(async (name) => {
      if (name !== TASK_JOB_NAMES.START) return;
      atStart.push({ statuses: await statuses(), messages: await messages() });
    });
    seen.length = 0;
    atStart.length = 0;
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'x',
      emailBlindIndex: 'plan-kb-create-test',
      passwordHash: 'x',
    });
    await db
      .insert(schema.repositories)
      .values({ id: REPO, userId: USER, name: 'repo', source: 'local_path', localPath: '/tmp/x' });
    await db.insert(schema.cliProviders).values({
      id: CLI,
      userId: USER,
      name: 'claude-code',
      label: 'claude-code',
      enabled: true,
    });
    await db.insert(schema.planNodes).values({
      id: NODE,
      repositoryId: REPO,
      parentId: null,
      path: `/${NODE}/`,
      title: 'Root',
      ordinal: 0,
      kind: 'component',
      status: 'todo',
      version: 1,
    });
  });

  afterAll(async () => {
    h.beforeQueued = undefined;
    await db.delete(schema.users).where(eq(schema.users.id, USER));
    await db.$client.end({ timeout: 5 });
    await observer.$client.end({ timeout: 5 });
  });

  // Each check samples the committed rows between the statements that create a task: before it
  // moves to `queued`, and when START goes on the queue.
  describe('spawnPlanTask', () => {
    it('is never seen created by another connection, and queues START after the commit', async () => {
      await spawn({ seed: sample });

      expect(seen).toHaveLength(2);
      neverCreated();
      expect(await statuses()).toEqual(['queued']);
      expect(atStart).toEqual([{ statuses: ['queued'], messages: 0 }]);
    });

    it('hands the seed the creating transaction, which a row that names the task needs', async () => {
      const taskId = await spawn({
        seed: async (id, tx) => {
          await tx.insert(schema.taskStepCliChoices).values({
            taskId: id,
            stepId: '00b-plan-clarify',
            role: 'questioner',
            cliProviderId: null,
          });
        },
      });

      expect(await choices(taskId)).toHaveLength(1);
    });

    it('leaves no task and queues nothing when the seed fails', async () => {
      await expect(
        spawn({
          seed: async () => {
            throw new Error('seed failed');
          },
        }),
      ).rejects.toThrow('seed failed');

      expect(await statuses()).toEqual([]);
      expect(h.add).not.toHaveBeenCalled();
    });

    it('leaves a deferred start created, for the start action to claim', async () => {
      await spawn({ type: 'plan_build', enqueue: false });

      expect(await statuses()).toEqual(['created']);
      expect(h.add).not.toHaveBeenCalled();
    });

    it('queues a task made in a caller-owned transaction with it, and leaves START to the caller', async () => {
      await db.transaction(async (tx) => {
        await spawn({ db: tx, type: 'plan_merge' });
        await sample();
      });

      expect(seen.flat()).toEqual([]);
      expect(await statuses()).toEqual(['queued']);
      expect(h.add).not.toHaveBeenCalled();
    });
  });

  describe('the plan routes', () => {
    it('queue a chat with its opening turn written before START', async () => {
      const res = await send(`/repositories/${REPO}/plan/nodes/${NODE}/chat`, {
        message: 'Split payments out.',
      });

      expect(res.status).toBe(201);
      neverCreated();
      expect(atStart).toEqual([{ statuses: ['queued'], messages: 1 }]);
    });

    it('queue a build with the questioner it was started with', async () => {
      await db.delete(schema.planNodes).where(eq(schema.planNodes.id, NODE));

      const res = await send(`/repositories/${REPO}/plan/build`, {
        mode: 'greenfield',
        description: 'Clubs',
        cliProviderId: CLI,
        questionerCliProviderId: CLI,
      });

      expect(res.status).toBe(201);
      const { taskId } = (await res.json()) as { taskId: string };
      expect(await choices(taskId)).toMatchObject([
        { stepId: '00b-plan-clarify', role: 'questioner', cliProviderId: CLI },
      ]);
      neverCreated();
      expect(atStart).toEqual([{ statuses: ['queued'], messages: 0 }]);
    });

    it.each(['sequence', 'merge'])('queue a %s task', async (route) => {
      expect((await send(`/repositories/${REPO}/plan/${route}`, {})).status).toBe(201);

      neverCreated();
      expect(await statuses()).toEqual(['queued']);
      expect(atStart).toEqual([{ statuses: ['queued'], messages: 0 }]);
    });

    it('queue one advisory for two clicks on a node, and queue its START once', async () => {
      const path = `/repositories/${REPO}/plan/nodes/${NODE}/advisory`;
      const first = (await (await send(path, { question: 'Which queue?' })).json()) as {
        taskId: string;
      };
      const second = (await (await send(path, { question: 'Which queue?' })).json()) as {
        taskId: string;
      };

      expect(second.taskId).toBe(first.taskId);
      neverCreated();
      expect(await statuses()).toEqual(['queued']);
      expect(atStart).toHaveLength(1);
    });
  });

  describe('POST /global-kb/enrich', () => {
    const enrich = (seedText = 'bloats the cache') =>
      send('/global-kb/enrich', { title: 'Never inline SVG', seedText, cliProviderId: CLI });

    it('is never seen created by another connection, and queues START after the commit', async () => {
      const kb = createFakeDb({ globalKbEntries });
      h.gdb = kb.db;
      kb.hooks.beforeInsert = sample;
      kb.hooks.beforeUpdate = sample;

      const res = await enrich();

      expect(res.status).toBe(201);
      neverCreated();
      expect(await statuses()).toEqual(['queued']);
      expect(atStart).toEqual([{ statuses: ['queued'], messages: 0 }]);
    });

    it('removes the skeleton and leaves no task when Postgres refuses the task insert', async () => {
      const kb = createFakeDb({ globalKbEntries });
      h.gdb = kb.db;

      const res = await enrich(`bloats${String.fromCharCode(0)} the cache`);

      expect(res.status).toBe(500);
      expect(await statuses()).toEqual([]);
      expect(kb.rows(globalKbEntries)).toEqual([]);
      expect(h.add).not.toHaveBeenCalled();
    });
  });
});
