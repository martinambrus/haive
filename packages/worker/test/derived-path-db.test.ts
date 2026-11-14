import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { EXECUTION_PATHS } from '@haive/shared';
import { parseDerivedRunPlan, type DerivedRunPlan } from '@haive/shared/modularity';
import { pinDerivedWorkflowPath } from '../src/step-engine/derived-path.js';
import { stepRegistry, StepRegistry } from '../src/step-engine/registry.js';
import { handleResult } from '../src/queues/task-queue.js';
import { deadTaskResolution, reconcileDeadTasks } from '../src/queues/dead-task-boot.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: Record<string, unknown> }[],
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (original) => ({
  ...(await original<object>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<object>()),
  Queue: class {
    async add(name: string, data: Record<string, unknown>) {
      h.adds.push({ name, data });
    }
  },
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (original) => ({
  ...(await original<object>()),
  killCliSandboxesForTask: async () => 0,
}));
vi.mock('../src/project-state/set-aside.js', async (original) => ({
  ...(await original<object>()),
  resyncAfterTaskEnd: async () => undefined,
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<object>()),
  configService: {
    getFresh: async () => 'normal',
    get: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

const url = process.env.DERIVED_PATH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/derived_path_test'))
  throw new Error('Use a dedicated derived_path_test database');
const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
const paths = [null, ...EXECUTION_PATHS];
const tail = (path: string | null) =>
  path === 'quick_bugfix' ? 'quick' : path === 'plan_tasklist' ? 'plan' : 'full';
const ids = [...prefix, 'quick', 'plan', 'full'];
const pin = (): DerivedRunPlan => ({
  version: 1,
  base: {
    slug: 'workflow',
    runListStrategy: 'workflow_paths',
    candidates: paths.map((executionPath) => ({ executionPath, stepIds: [...prefix, 'full'] })),
    catalogFingerprint: 'test-generation',
  },
  overlay: { revision: 'revision-1', changes: [] },
  requiresRepository: true,
  composableEntries: ids.map((stepId) => ({
    stepId,
    label: stepId,
    group: 'test',
    dispatchesCli: false,
    requires: [],
    provides: [],
  })),
  candidates: paths.map((executionPath) => ({
    executionPath,
    stepIds: [...prefix, tail(executionPath)],
    outcomes: [],
    compositionIssues: [],
  })),
  commonPrefix: prefix,
  warnings: [],
});
const registry = (omit?: string) => {
  const r = new StepRegistry();
  ids
    .filter((id) => id !== omit)
    .forEach((id, index) =>
      r.register({
        metadata: {
          id,
          index,
          workflowType: 'workflow',
          title: id,
          description: id,
          requiresCli: false,
        },
        detect: async () => ({}),
        form: () => ({ title: id, fields: [] }),
        apply: async () => ({}),
      }),
    );
  return r;
};

describe.skipIf(!url)('derived triage pin on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;
  let taskId: string;
  let stepId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    registry()
      .all()
      .forEach((step) => stepRegistry.override(step));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'derived-test@example.invalid',
        emailBlindIndex: randomUUID(),
        passwordHash: randomUUID(),
        role: 'user',
        status: 'active',
      })
      .returning();
    userId = user!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'derived-test',
        source: 'local_path',
        localPath: '/tmp',
        storagePath: '/tmp',
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;
  });
  afterAll(async () => {
    await db.execute(sql`DROP TRIGGER IF EXISTS derived_event_failure ON task_events`);
    await db.execute(sql`DROP FUNCTION IF EXISTS derived_event_failure()`);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.id, repositoryId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    h.adds = [];
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'derived-test',
        title: 'Derived',
        status: 'running',
        currentStepId: '00-triage',
        currentRound: 0,
        orchestrationEpoch: 3,
        derivedRunPlan: pin(),
        runListSnapshot: [...prefix, 'full'],
        preAnswers: { quick: { answer: true }, full: { answer: false } },
        stepLoopLimits: { quick: 2, full: 4 },
      })
      .returning();
    taskId = task!.id;
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: '00-triage',
        round: 0,
        status: 'running',
        stepIndex: 2,
        title: 'Triage',
      })
      .returning();
    stepId = step!.id;
  });
  const waitForStepLock = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const waiting = await db.execute(
        sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND strpos(query, 'task_steps') > 0`,
      );
      if (waiting.length) return;
    }
    throw new Error('Expected triage to wait for step ownership');
  };
  const ctx = () => ({ db, taskId, taskStepId: stepId, round: 0, epoch: 3 });
  const task = async () =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!;
  const events = () =>
    db
      .select()
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, taskId),
          eq(schema.taskEvents.eventType, 'task.derived_path_pinned'),
        ),
      );

  it.each(EXECUTION_PATHS)(
    'selects %s once and replays after a crash without consulting live definitions',
    async (path) => {
      await pinDerivedWorkflowPath(ctx(), path, false, registry());
      const selected = await task();
      expect(selected.runListSnapshot).toEqual([...prefix, tail(path)]);
      expect(selected.executionPath).toBe(path);
      expect(selected.broadAudit).toBe(false);
      expect(selected.derivedRunPlan).toEqual(pin());
      await db
        .update(schema.taskSteps)
        .set({ status: 'done' })
        .where(eq(schema.taskSteps.id, stepId));
      await pinDerivedWorkflowPath(ctx(), path, true, registry());
      expect(await events()).toHaveLength(1);
      expect((await task()).broadAudit).toBe(false);
      await expect(
        pinDerivedWorkflowPath(
          ctx(),
          EXECUTION_PATHS.find((p) => p !== path)!,
          true,
          registry(),
        ),
      ).rejects.toMatchObject({ code: 'derived_path_pinned' });
      expect((await task()).runListSnapshot).toEqual(selected.runListSnapshot);
    },
  );
  it('prunes task-only defaults and keeps the immutable plan through a full retry', async () => {
    await pinDerivedWorkflowPath(ctx(), 'quick_bugfix', false, registry());
    expect(await task()).toMatchObject({
      preAnswers: { quick: { answer: true } },
      stepLoopLimits: { quick: 2 },
    });
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, stepId));
    await db.update(schema.tasks).set({ orchestrationEpoch: 4 }).where(eq(schema.tasks.id, taskId));
    await pinDerivedWorkflowPath({ ...ctx(), epoch: 4 }, 'quick_bugfix', true, registry());
    expect(await task()).toMatchObject({
      executionPath: 'quick_bugfix',
      runListSnapshot: [...prefix, 'quick'],
      derivedRunPlan: pin(),
    });
    expect(await events()).toHaveLength(1);
  });
  it.each([
    { task: { status: 'failed' as const } },
    { task: { status: 'cancelled' as const } },
    { task: { orchestrationEpoch: 4 } },
    { task: { currentRound: 1 } },
    { task: { currentStepId: 'full' } },
    { step: { status: 'pending' as const } },
    { step: { status: 'skipped' as const } },
    { step: { status: 'failed' as const } },
  ])('refuses a superseded attempt %j without pinning', async (patch) => {
    if (patch.task)
      await db.update(schema.tasks).set(patch.task).where(eq(schema.tasks.id, taskId));
    if (patch.step)
      await db.update(schema.taskSteps).set(patch.step).where(eq(schema.taskSteps.id, stepId));
    await expect(
      pinDerivedWorkflowPath(ctx(), 'quick_bugfix', true, registry()),
    ).rejects.toMatchObject({ name: 'StepSupersededError' });
    expect((await task()).executionPath).toBeNull();
    expect(await events()).toHaveLength(0);
  });
  it('rolls back selection and defaults if its application event cannot be written', async () => {
    await db.execute(
      sql`CREATE FUNCTION derived_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'task.derived_path_pinned' THEN RAISE EXCEPTION 'event refused'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER derived_event_failure BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION derived_event_failure()`,
    );
    try {
      await expect(
        pinDerivedWorkflowPath(ctx(), 'quick_bugfix', true, registry()),
      ).rejects.toThrow();
      expect(await task()).toMatchObject({
        executionPath: null,
        runListSnapshot: [...prefix, 'full'],
        preAnswers: { quick: { answer: true }, full: { answer: false } },
      });
      expect(await events()).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER derived_event_failure ON task_events`);
      await db.execute(sql`DROP FUNCTION derived_event_failure()`);
    }
  });
  it('refuses missing code before selecting, then boot resolution judges the pinned union and chosen list', async () => {
    await expect(
      pinDerivedWorkflowPath(ctx(), 'quick_bugfix', true, registry('quick')),
    ).rejects.toMatchObject({ ids: ['quick'] });
    expect((await task()).executionPath).toBeNull();
    const unresolved = deadTaskResolution(await task(), 'derived', registry('quick'));
    expect(unresolved.unresolved).toEqual(['quick']);
    await pinDerivedWorkflowPath(ctx(), 'full_workflow', true, registry());
    expect(deadTaskResolution(await task(), 'derived', registry('quick')).unresolved).toEqual([]);
    expect(() => parseDerivedRunPlan({ ...pin(), version: 2 })).toThrow(
      expect.objectContaining({ code: 'invalid-derived-run-plan' }),
    );
  });
  it('locks the step before the task so a Retry holding that step can complete and fence selection', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const retry = db.transaction(async (tx) => {
      await tx
        .update(schema.taskSteps)
        .set({ status: 'pending' })
        .where(eq(schema.taskSteps.id, stepId));
      acquired();
      await gate;
      await tx
        .update(schema.tasks)
        .set({ orchestrationEpoch: 4 })
        .where(eq(schema.tasks.id, taskId));
    });
    await locked;
    const selecting = pinDerivedWorkflowPath(ctx(), 'quick_bugfix', true, registry());
    try {
      await waitForStepLock();
    } finally {
      release();
    }
    await retry;
    await expect(selecting).rejects.toMatchObject({ name: 'StepSupersededError' });
    expect((await task()).executionPath).toBeNull();
  });
  it('refreshes handleResult from a committed path before choosing the successor', async () => {
    await pinDerivedWorkflowPath(ctx(), 'quick_bugfix', true, registry());
    const [done] = await db
      .update(schema.taskSteps)
      .set({ status: 'done', output: {}, endedAt: new Date() })
      .where(eq(schema.taskSteps.id, stepId))
      .returning();
    const pickup = {
      taskId,
      userId,
      workflowType: 'derived-test',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      ignoreSavedStepClis: false,
      executionPath: null,
      metadata: null,
      orchestrationEpoch: 3,
      currentStepId: '00-triage',
      currentRound: 0,
      status: 'running',
      completedAt: null,
      runListStrategy: 'derived',
      derivedRunPlan: pin(),
      runListSnapshot: [...prefix, 'full'],
    } as Parameters<typeof handleResult>[1];
    await handleResult(db, pickup, '00-triage', { status: 'done', row: done!, output: {} });
    expect((await task()).currentStepId).toBe('quick');
    expect(h.adds).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ stepId: 'quick' }) }),
    );
    expect(pickup.executionPath).toBe('quick_bugfix');
  });
  it('marks and revives an unselected derived task at boot using every pinned candidate', async () => {
    const sent: string[] = [];
    const deps = {
      enqueueStart: async () => undefined,
      enqueueAdvance: async (id: string) => {
        sent.push(id);
      },
      redriveRetryDelaysMs: [],
    };
    const original = stepRegistry.get.bind(stepRegistry);
    const missing = vi
      .spyOn(stepRegistry, 'get')
      .mockImplementation((id) => (id === 'quick' ? undefined : original(id)));
    try {
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 1, revived: 0 });
      expect((await task()).deadAt).not.toBeNull();
      expect((await task()).derivedRunPlan).toEqual(pin());
    } finally {
      missing.mockRestore();
    }
    expect(await reconcileDeadTasks(db, deps)).toMatchObject({ revived: 1 });
    expect(await task()).toMatchObject({
      deadAt: null,
      executionPath: null,
      runListSnapshot: [...prefix, 'full'],
      derivedRunPlan: pin(),
    });
    expect(sent).toEqual([taskId]);
  });
  it.each(['failed', 'cancelled'] as const)(
    'waits behind %s step ownership before refusing selection',
    async (status) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired!: () => void;
      const locked = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const stopping = db.transaction(async (tx) => {
        await tx
          .update(schema.taskSteps)
          .set({ status: 'failed' })
          .where(eq(schema.taskSteps.id, stepId));
        acquired();
        await gate;
        await tx
          .update(schema.tasks)
          .set({ status, ...(status === 'cancelled' ? { orchestrationEpoch: 4 } : {}) })
          .where(eq(schema.tasks.id, taskId));
      });
      await locked;
      const selecting = pinDerivedWorkflowPath(ctx(), 'quick_bugfix', true, registry());
      try {
        await waitForStepLock();
      } finally {
        release();
      }
      await stopping;
      await expect(selecting).rejects.toMatchObject({ name: 'StepSupersededError' });
      expect((await task()).executionPath).toBeNull();
    },
  );
});
