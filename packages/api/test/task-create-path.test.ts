import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, schema, type Database } from '@haive/database';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { loadLiveRootWriters } from '../src/routes/repos.js';
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
    stepId === 'cp-needs' ? { requires: [{ needs: 'nothing-provides-this', reason: 'x' }] } : {},
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
        inArray(schema.taskTypeDefinitions.slug, [...SLUGS, 'onboarding', 'workflow', 'run_app']),
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
    expect((await post({ type: 'cp-norepo' })).status).toBe(409);
    expect((await post({ type: 'cp-norepo', repositoryId: REPO })).status).toBe(409);
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
});
