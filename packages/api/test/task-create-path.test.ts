import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TASK_CREATE_PATH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_create_path_test'))
  throw new Error('Use a dedicated task_create_path_test database for create path tests');

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000e1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

import { and, eq, inArray, notExists, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { adminTaskTypeRoutes } from '../src/routes/task-types.js';
import { loadLiveRootWriters } from '../src/routes/repos.js';
import { definitionForCreate } from '../src/lib/task-type-definition.js';
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
app.use(async (c, next) => {
  c.set('maintenanceState', 'normal');
  await next();
});
app.route('/tasks', taskRoutes);
app.route('/admin/task-types', adminTaskTypeRoutes);
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

  describe('a completed dump the upload reaper claims while a task is created for it', () => {
    const DUMP = '00000000-0000-4000-8000-0000000000e3';
    const BLOCKED_WITHIN_MS = 10_000;
    type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
    let reaperDb: Database;

    beforeAll(() => {
      reaperDb = createDatabase(url as string);
    });
    afterAll(async () => {
      await reaperDb.$client.end({ timeout: 5 });
    });
    beforeEach(async () => {
      await db.insert(schema.dbUploads).values({
        id: DUMP,
        userId: USER,
        filename: 'a.sql',
        dumpFormat: 'sql',
        totalSize: 10,
        bytesReceived: 10,
        chunkSize: 10,
        dumpPath: `/tmp/uploads/db-${DUMP}.sql`,
        status: 'complete',
      });
    });

    const withDump = async () => post({ type: 'cp-plain', repositoryId: REPO, dbUploadId: DUMP });
    const dumpStatus = async () =>
      (await db.select().from(schema.dbUploads).where(eq(schema.dbUploads.id, DUMP)))[0]!.status;
    const tasksNamingTheDump = async () =>
      (await db.select().from(schema.tasks).where(eq(schema.tasks.dbUploadId, DUMP))).length;

    const settle = <T>(run: Promise<T>) =>
      run.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    const backendPid = async (tx: Tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      return row!.pid;
    };

    // Returns once a statement waits on a lock the backend `holderPid` holds, and throws when `ended`
    // turns true first, as a statement that did not wait would.
    async function untilBlockedBy(holderPid: number, ended: () => boolean) {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      for (;;) {
        if (ended()) throw new Error('the statement ended without waiting for the lock');
        const [row] = await db.execute<{ blocked: number }>(sql`
          select count(*)::int as blocked from pg_stat_activity
          where wait_event_type = 'Lock' and ${holderPid}::int = any (pg_blocking_pids(pid))`);
        if (row!.blocked > 0) return;
        if (Date.now() > deadline) {
          throw new Error(`nothing waited on pid ${holderPid} within ${BLOCKED_WITHIN_MS} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    // The reaper's claim of a completed dump (reapEndedDumps in the worker) on its own connection;
    // `hold` keeps its transaction open, claim made, until `commit`.
    function reapClaim(hold: boolean) {
      let commit!: () => void;
      const committing = new Promise<void>((resolve) => (commit = resolve));
      if (!hold) commit();
      let claimed!: (pid: number) => void;
      const claimedPid = new Promise<number>((resolve) => (claimed = resolve));
      const done = settle(
        reaperDb.transaction(async (tx) => {
          const pid = await backendPid(tx);
          const [locked] = await tx
            .select({ id: schema.dbUploads.id })
            .from(schema.dbUploads)
            .where(and(eq(schema.dbUploads.id, DUMP), eq(schema.dbUploads.status, 'complete')))
            .for('update');
          if (!locked) return 0;
          const taken = await tx
            .update(schema.dbUploads)
            .set({ status: 'reaping', updatedAt: new Date() })
            .where(
              and(
                eq(schema.dbUploads.id, DUMP),
                eq(schema.dbUploads.status, 'complete'),
                notExists(
                  tx
                    .select({ id: schema.tasks.id })
                    .from(schema.tasks)
                    .where(eq(schema.tasks.dbUploadId, DUMP)),
                ),
              ),
            )
            .returning({ id: schema.dbUploads.id });
          claimed(pid);
          await committing;
          return taken.length;
        }),
      );
      const pid = () =>
        Promise.race([
          claimedPid,
          done.then(() => {
            throw new Error('the reaper transaction ended before it made its claim');
          }),
        ]);
      return { pid, commit, done };
    }

    // The route's database with a stop at its task insert: `before` the insert runs, or `after` it ran
    // and before the transaction commits.
    function stopAtTheTaskInsert(at: 'before' | 'after') {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let reach!: (pid: number) => void;
      const reached = new Promise<number>((resolve) => (reach = resolve));
      const stopHere = async (tx: Tx) => {
        reach(await backendPid(tx));
        await hold;
      };
      const wrapTx = (tx: Tx): Tx =>
        new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop !== 'insert') return typeof value === 'function' ? value.bind(target) : value;
            return (table: typeof schema.tasks) => {
              const query = target.insert(table);
              if (table !== schema.tasks) return query;
              return {
                values: (values: never) => ({
                  returning: async () => {
                    if (at === 'before') await stopHere(target);
                    const rows = await query.values(values).returning();
                    if (at === 'after') await stopHere(target);
                    return rows;
                  },
                }),
              };
            };
          },
        });
      const stopped = new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== 'transaction') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (fn: (tx: Tx) => Promise<unknown>) => target.transaction((tx) => fn(wrapTx(tx)));
        },
      });
      return { db: stopped, release, reached };
    }

    it('answers 409 when the reaper claimed the dump first, once that claim commits', async () => {
      const reaper = reapClaim(true);
      const reaperPid = await reaper.pid();
      const state = { ended: false };
      const request = settle(withDump());
      void request.then(() => (state.ended = true));
      try {
        await untilBlockedBy(reaperPid, () => state.ended);
      } finally {
        reaper.commit();
        await reaper.done;
        await request;
      }

      const outcome = await request;
      expect(outcome.ok && outcome.value.status).toBe(409);
      expect(outcome.ok && ((await outcome.value.json()) as { error: string }).error).toBe(
        'DB dump upload is reaping, not complete',
      );
      expect(await reaper.done).toEqual({ ok: true, value: 1 });
      expect(await dumpStatus()).toBe('reaping');
      expect(await taskCount()).toBe(0);
    }, 30_000);

    it('answers 409 for a dump a dead worker left reaping, and creates no task', async () => {
      await db
        .update(schema.dbUploads)
        .set({ status: 'reaping' })
        .where(eq(schema.dbUploads.id, DUMP));

      const res = await withDump();

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(
        'DB dump upload is reaping, not complete',
      );
      expect(await taskCount()).toBe(0);
    });

    it.each(['before', 'after'] as const)(
      'makes the reaper wait for a task transaction stopped %s its task insert, and keeps the dump',
      async (at) => {
        const gate = stopAtTheTaskInsert(at);
        h.db = gate.db;
        const request = settle(withDump());
        const routePid = await Promise.race([
          gate.reached,
          request.then(() => {
            throw new Error('the request ended before it reached its task insert');
          }),
        ]);
        const reaper = reapClaim(false);
        const state = { ended: false };
        void reaper.done.then(() => (state.ended = true));
        try {
          await untilBlockedBy(routePid, () => state.ended);
        } finally {
          gate.release();
          await request;
          await reaper.done;
        }

        const outcome = await request;
        expect(outcome.ok && outcome.value.status).toBe(201);
        expect(await reaper.done).toEqual({ ok: true, value: 0 });
        expect(await dumpStatus()).toBe('complete');
        expect(await tasksNamingTheDump()).toBe(1);
      },
      30_000,
    );
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
