import type { Job } from 'bullmq';
import { eq, getTableName, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { computeStepContribution, computeTaskTiming } from '@haive/shared/timing';
import { moduleActivationState, moduleDeactivationMessage } from '../src/modules/activation.js';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { advanceStep, type AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add() {
      return undefined;
    }
  },
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  cleanupTaskAuthVolumes: vi.fn(async () => ({ removed: [], failed: [] })),
  syncRefreshedAuthToUserVolumes: vi.fn(async () => undefined),
}));

const url = process.env.MODULE_DEACTIVATED_STEP_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_deactivated_step_test'))
  throw new Error('Use a dedicated module_deactivated_step_test database for module step tests');

const OFF = new Date('2026-10-14T08:00:00.000Z');
const HANDED_OFF = 'the advance that called read this module as deactivated';

function stepDef(id: string, extra: Partial<StepDefinition> = {}): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'workflow',
      index: 0,
      title: id,
      description: id,
      requiresCli: false,
    },
    async detect() {
      throw new Error('detect must not run');
    },
    async apply() {
      throw new Error('apply must not run');
    },
    ...extra,
  };
}

const phases = {
  shouldRun: vi.fn(async () => true),
  detect: vi.fn(async (): Promise<never> => {
    throw new Error('detect must not run');
  }),
  apply: vi.fn(async (): Promise<never> => {
    throw new Error('apply must not run');
  }),
};
stepRegistry.register({
  metadata: {
    id: 'module.alpha.x',
    workflowType: 'module.alpha' as WorkflowType,
    index: 0,
    title: 'module.alpha.x',
    description: 'the first step of a module run list',
    requiresCli: false,
  },
  ...phases,
});

function paramsFor(db: Database, step: StepDefinition, taskId: string): AdvanceStepParams {
  return {
    db,
    taskId,
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    stepDef: step,
    providers: [],
    runSeq: 0,
  };
}

function expectNamedReason(message: string): void {
  expect(message).toMatch(/alpha/);
  expect(message).toMatch(/module\.alpha\.x/);
  expect(message).toMatch(/reactivate/i);
  expect(message).toMatch(/retry/i);
}

interface MockState {
  modules: { deactivatedAt: Date | null }[];
  row: Record<string, unknown>;
  /** False when a Retry or a Skip took the step row before this pass wrote it. */
  owned: boolean;
  reads: string[];
  writes: string[];
  patches: Record<string, unknown>[];
}

const ROW = {
  id: 'ts-1',
  taskId: 'task-1',
  stepId: 'any',
  stepIndex: 0,
  round: 0,
  runSeq: 0,
  output: { ok: true },
  detectOutput: { ready: true },
  errorMessage: null,
  statusMessage: null,
};

function mockDb(state: MockState): Database {
  const refuse = (kind: string) => (table: unknown) => {
    state.writes.push(`${kind} ${getTableName(table as never)}`);
    throw new Error('no write expected');
  };
  return {
    select: () => ({
      from: (table: never) => {
        const name = getTableName(table);
        state.reads.push(name);
        return {
          where: () => ({
            limit: async () =>
              name === 'modules' ? state.modules : name === 'task_steps' ? [state.row] : [],
          }),
        };
      },
    }),
    update: (table: never) => ({
      set: (patch: Record<string, unknown>) => {
        state.writes.push(`update ${getTableName(table)}`);
        state.patches.push(patch);
        return {
          where: () =>
            Object.assign(Promise.resolve([]), {
              returning: async () => (state.owned ? [{ ...state.row, ...patch }] : []),
            }),
        };
      },
    }),
    insert: refuse('insert'),
    delete: refuse('delete'),
    query: { tasks: { findFirst: async () => ({ id: 'task-1', status: 'running' }) } },
  } as unknown as Database;
}

describe('advanceStep on a module step', () => {
  const run = (
    id: string,
    modules: MockState['modules'],
    status: string,
    extra: Partial<StepDefinition> = {},
    owned = true,
    moduleDeactivation?: string | null,
  ) => {
    const state: MockState = {
      modules,
      row: { ...ROW, stepId: id, status },
      owned,
      reads: [],
      writes: [],
      patches: [],
    };
    return {
      state,
      result: advanceStep({
        ...paramsFor(mockDb(state), stepDef(id, extra), 'task-1'),
        moduleDeactivation,
      }),
    };
  };
  const FOLD_THEN_FAIL = ['update task_steps', 'update task_steps'];

  it.each(['pending', 'running', 'waiting_form', 'waiting_cli'])(
    'fails the %s row of a deactivated module and runs none of its code',
    async (status) => {
      const shouldRun = vi.fn(async () => true);
      const { state, result } = run('module.alpha.x', [{ deactivatedAt: OFF }], status, {
        shouldRun,
      });
      const outcome = await result;
      expect(outcome).toMatchObject({ status: 'failed', row: { status: 'failed' } });
      const { error, row } = outcome as { error: string; row: { errorMessage: string } };
      expectNamedReason(error);
      expect(row.errorMessage).toBe(error);
      expect(state.reads).toEqual(['task_steps', 'modules']);
      expect(state.writes).toEqual(FOLD_THEN_FAIL);
      expect(state.patches[0]).toHaveProperty('waitingStartedAt', null);
      expect(state.patches.at(-1)).toMatchObject({
        status: 'failed',
        statusMessage: null,
        errorMessage: error,
      });
      expect(state.patches.at(-1)?.endedAt).toBeInstanceOf(Date);
      expect(shouldRun).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'waiting_form'])(
    'hands the %s row back as superseded when a Retry or a Skip took it first',
    async (status) => {
      const shouldRun = vi.fn(async () => true);
      const { state, result } = run(
        'module.alpha.x',
        [{ deactivatedAt: OFF }],
        status,
        { shouldRun },
        false,
      );
      await expect(result).resolves.toMatchObject({ status: 'superseded' });
      expect(state.writes).toEqual(FOLD_THEN_FAIL);
      expect(shouldRun).not.toHaveBeenCalled();
    },
  );

  it.each(['done', 'skipped', 'failed'])(
    'hands back a %s row untouched, whatever its module',
    async (status) => {
      const { state, result } = run('module.alpha.x', [{ deactivatedAt: OFF }], status);
      await expect(result).resolves.toMatchObject({ status });
      expect(state.reads).toEqual(['task_steps']);
      expect(state.writes).toEqual([]);
    },
  );

  it.each([
    ['is active', [{ deactivatedAt: null }]],
    ['has no row', []],
  ])('goes on when the module %s', async (_label, modules) => {
    const shouldRun = vi.fn(async () => false);
    const { state, result } = run('module.alpha.x', modules, 'pending', { shouldRun });
    await expect(result).resolves.toMatchObject({ status: 'skipped' });
    expect(shouldRun).toHaveBeenCalledTimes(1);
    expect(state.reads).toEqual(['task_steps', 'modules']);
    expect(state.patches.some((p) => p.status === 'skipped')).toBe(true);
    expect(state.patches.some((p) => p.status === 'failed')).toBe(false);
  });

  it.each(['pending', 'running', 'waiting_form', 'waiting_cli'])(
    'fails the %s row with the message its caller read, reading no module again',
    async (status) => {
      const shouldRun = vi.fn(async () => true);
      const { state, result } = run(
        'module.alpha.x',
        [{ deactivatedAt: null }],
        status,
        { shouldRun },
        true,
        HANDED_OFF,
      );
      await expect(result).resolves.toMatchObject({
        status: 'failed',
        error: HANDED_OFF,
        row: { status: 'failed', errorMessage: HANDED_OFF },
      });
      expect(state.reads).toEqual(['task_steps']);
      expect(state.writes).toEqual(FOLD_THEN_FAIL);
      expect(shouldRun).not.toHaveBeenCalled();
    },
  );

  it('runs the step on the on decision its caller made, reading no module again', async () => {
    const shouldRun = vi.fn(async () => false);
    const { state, result } = run(
      'module.alpha.x',
      [{ deactivatedAt: OFF }],
      'pending',
      { shouldRun },
      true,
      null,
    );
    await expect(result).resolves.toMatchObject({ status: 'skipped' });
    expect(shouldRun).toHaveBeenCalledTimes(1);
    expect(state.reads).toEqual(['task_steps']);
    expect(state.patches.some((p) => p.status === 'failed')).toBe(false);
  });

  it.each(['01-worktree-setup', 'term_step', 'custom.my-type.review'])(
    'issues no modules query for %s',
    async (id) => {
      const { state, result } = run(id, [{ deactivatedAt: OFF }], 'pending', {
        shouldRun: async () => false,
      });
      await expect(result).resolves.toMatchObject({ status: 'skipped' });
      expect(state.reads).toEqual(['task_steps']);
    },
  );
});

describe.skipIf(!url)('module activation guard on Postgres', () => {
  const EMAIL_INDEX = 'module-deactivated-step-test-user';
  const START_TYPE = 'module-start-guard';
  let db: Database;
  let userId: string;
  let taskId: string;

  const setModule = (moduleId: string, deactivatedAt: Date | null) =>
    db.insert(schema.modules).values({
      moduleId,
      packageName: `@haive/module-${moduleId}`,
      name: moduleId,
      installedVersion: '1.0.0',
      deactivatedAt,
    });
  const reactivate = (moduleId: string) =>
    db
      .update(schema.modules)
      .set({ deactivatedAt: null })
      .where(eq(schema.modules.moduleId, moduleId));
  const stepRows = () =>
    db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));
  const taskEpoch = async () => {
    const [task] = await db
      .select({ epoch: schema.tasks.orchestrationEpoch })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    return task!.epoch;
  };
  const parkRow = () =>
    db.insert(schema.taskSteps).values({
      taskId,
      stepId: 'module.alpha.x',
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: 'module.alpha.x',
      status: 'pending',
      waitingStartedAt: sql`now() - interval '90 seconds'`,
    });
  const expectParkFolded = async () => {
    const [row] = await stepRows();
    const idle = computeTaskTiming(row ? [row] : [], Date.now()).idleMs;
    expect(idle).toBeGreaterThanOrEqual(89_000);
    expect(idle).toBeLessThan(120_000);
    expect(row?.waitingStartedAt).toBeNull();
  };
  const startedRow = (
    status: 'running' | 'waiting_form' | 'waiting_cli',
    idleMs: number,
    waiting: boolean,
  ) =>
    db.insert(schema.taskSteps).values({
      taskId,
      stepId: 'module.alpha.x',
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: 'module.alpha.x',
      status,
      startedAt: sql`now() - interval '10 minutes'`,
      idleMs,
      waitingStartedAt: waiting ? sql`now() - interval '5 minutes'` : null,
    });

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'module-deactivated-step-test@test.local',
        emailBlindIndex: EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
  });

  beforeEach(async () => {
    await db.delete(schema.modules);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'guard' })
      .returning();
    taskId = task!.id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    setContainerCleanupRunner(null);
    await db.delete(schema.modules);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, START_TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  it('names a step of a deactivated module and no other', async () => {
    await setModule('alpha', OFF);
    await setModule('alpha-two', null);
    expectNamedReason((await moduleDeactivationMessage(db, 'module.alpha.x')) ?? '');
    await expect(moduleDeactivationMessage(db, 'module.alpha-two.x')).resolves.toBeNull();
    await expect(moduleDeactivationMessage(db, 'module.ghost.x')).resolves.toBeNull();
  });

  it('reads the deactivated modules and the updated_at of every module in one query', async () => {
    const at = new Date('2026-10-14T08:30:00.250Z');
    await setModule('alpha', OFF);
    await setModule('alpha-two', null);
    await db
      .update(schema.modules)
      .set({ updatedAt: at })
      .where(eq(schema.modules.moduleId, 'alpha'));
    let selects = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'select') selects += 1;
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const state = await moduleActivationState(counted);

    expect(selects).toBe(1);
    expect(state.deactivated).toEqual(new Set(['alpha']));
    expect([...state.stamps.keys()].sort()).toEqual(['alpha', 'alpha-two']);
    expect(state.stamps.get('alpha')).toBe(at.getTime());
  });

  it('waits, when locking, for a deactivation that holds the row, then names the module', async () => {
    await setModule('alpha', null);
    let raced: string | undefined;
    let read!: Promise<string | null>;
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.modules)
        .where(eq(schema.modules.moduleId, 'alpha'))
        .for('update');
      await tx
        .update(schema.modules)
        .set({ deactivatedAt: OFF })
        .where(eq(schema.modules.moduleId, 'alpha'));
      read = moduleDeactivationMessage(db, 'module.alpha.x', { lock: true });
      raced = await Promise.race([
        read.then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 400)),
      ]);
    });
    expect(raced).toBe('blocked');
    expectNamedReason((await read) ?? '');
  });

  it('names no module for a core or a custom step id', async () => {
    await setModule('alpha', OFF);
    await expect(moduleDeactivationMessage(db, '01-worktree-setup')).resolves.toBeNull();
    await expect(moduleDeactivationMessage(db, 'custom.alpha.review')).resolves.toBeNull();
  });

  it('fails the step row of a deactivated module, and a Retry runs it once the module is back', async () => {
    const shouldRun = vi.fn(async () => false);
    const step = stepDef('module.alpha.x', { shouldRun });
    await setModule('alpha', OFF);

    const failed = await advanceStep({ ...paramsFor(db, step, taskId), epoch: await taskEpoch() });
    expect(failed).toMatchObject({ status: 'failed', row: { status: 'failed' } });
    const message = (failed as { error: string }).error;
    expectNamedReason(message);
    const [row] = await stepRows();
    expect(row).toMatchObject({
      stepId: 'module.alpha.x',
      status: 'failed',
      errorMessage: message,
      statusMessage: null,
    });
    expect(row?.endedAt).toBeInstanceOf(Date);
    expect(shouldRun).not.toHaveBeenCalled();

    await reactivate('alpha');
    await expect(advanceStep(paramsFor(db, step, taskId))).resolves.toMatchObject({
      status: 'failed',
      error: message,
    });

    await expect(resetStepAndDownstream(db, taskId, 'module.alpha.x', 0)).resolves.toMatchObject({
      newEpoch: 1,
    });
    await expect(advanceStep({ ...paramsFor(db, step, taskId), epoch: 1 })).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(shouldRun).toHaveBeenCalledTimes(1);
    expect(await stepRows()).toMatchObject([
      { stepId: 'module.alpha.x', status: 'skipped', errorMessage: null },
    ]);
  });

  it('fails a row a form was parked on, which a Retry has not reset', async () => {
    const shouldRun = vi.fn(async () => true);
    await setModule('alpha', OFF);
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: 'module.alpha.x',
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: 'module.alpha.x',
      status: 'waiting_form',
    });
    await expect(
      advanceStep({ ...paramsFor(db, stepDef('module.alpha.x', { shouldRun }), taskId), epoch: 0 }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(await stepRows()).toMatchObject([{ status: 'failed', startedAt: null }]);
    expect(shouldRun).not.toHaveBeenCalled();
  });

  it('fails the step row with the message its caller read, though the module is back since', async () => {
    const shouldRun = vi.fn(async () => true);
    await setModule('alpha', OFF);
    const read = await moduleDeactivationMessage(db, 'module.alpha.x');
    await reactivate('alpha');
    await expect(
      advanceStep({
        ...paramsFor(db, stepDef('module.alpha.x', { shouldRun }), taskId),
        epoch: await taskEpoch(),
        moduleDeactivation: read,
      }),
    ).resolves.toMatchObject({ status: 'failed', error: read });
    expect(await stepRows()).toMatchObject([{ status: 'failed', errorMessage: read }]);
    expect(shouldRun).not.toHaveBeenCalled();
  });

  it('runs the step on the on decision its caller made, though the module is off since', async () => {
    const shouldRun = vi.fn(async () => false);
    await setModule('alpha', OFF);
    await expect(
      advanceStep({
        ...paramsFor(db, stepDef('module.alpha.x', { shouldRun }), taskId),
        moduleDeactivation: null,
      }),
    ).resolves.toMatchObject({ status: 'skipped' });
    expect(shouldRun).toHaveBeenCalledTimes(1);
    expect(await stepRows()).toMatchObject([
      { stepId: 'module.alpha.x', status: 'skipped', errorMessage: null },
    ]);
  });

  it('writes no failure for a pass a Retry has already moved past', async () => {
    const shouldRun = vi.fn(async () => true);
    await setModule('alpha', OFF);
    await db.update(schema.tasks).set({ orchestrationEpoch: 1 }).where(eq(schema.tasks.id, taskId));
    await expect(
      advanceStep({ ...paramsFor(db, stepDef('module.alpha.x', { shouldRun }), taskId), epoch: 0 }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(await stepRows()).toMatchObject([{ status: 'pending', errorMessage: null }]);
    expect(shouldRun).not.toHaveBeenCalled();
  });

  it('keeps the wait for a runtime slot as idle time when it fails a parked row', async () => {
    await setModule('alpha', OFF);
    await parkRow();
    await expect(
      advanceStep({
        ...paramsFor(db, stepDef('module.alpha.x'), taskId),
        epoch: await taskEpoch(),
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    await expectParkFolded();
  });

  it('folds the park, as a skip does, for a pass a Retry has already moved past', async () => {
    await setModule('alpha', OFF);
    await parkRow();
    await db.update(schema.tasks).set({ orchestrationEpoch: 1 }).where(eq(schema.tasks.id, taskId));
    await expect(
      advanceStep({ ...paramsFor(db, stepDef('module.alpha.x'), taskId), epoch: 0 }),
    ).resolves.toMatchObject({ status: 'superseded' });
    expect(await stepRows()).toMatchObject([
      { status: 'pending', errorMessage: null, endedAt: null },
    ]);
    await expectParkFolded();
  });

  it.each(['waiting_form', 'waiting_cli'] as const)(
    'keeps the open wait of a %s row as idle time when it fails the row',
    async (status) => {
      await setModule('alpha', OFF);
      await startedRow(status, 0, true);
      await expect(
        advanceStep(paramsFor(db, stepDef('module.alpha.x'), taskId)),
      ).resolves.toMatchObject({ status: 'failed' });
      const [row] = await stepRows();
      const { workMs } = computeStepContribution(row!, Date.now());
      expect(row?.idleMs).toBeGreaterThanOrEqual(295_000);
      expect(row?.idleMs).toBeLessThanOrEqual(305_000);
      expect(row?.waitingStartedAt).toBeNull();
      expect(workMs).toBeGreaterThanOrEqual(295_000);
      expect(workMs).toBeLessThanOrEqual(305_000);
    },
  );

  it('adds no idle time when it fails a running row that holds no wait', async () => {
    await setModule('alpha', OFF);
    await startedRow('running', 12_345, false);
    await expect(
      advanceStep(paramsFor(db, stepDef('module.alpha.x'), taskId)),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(await stepRows()).toMatchObject([
      { status: 'failed', idleMs: 12_345, carriedIdleMs: 0, waitingStartedAt: null },
    ]);
  });

  it('writes a row for an active module, and none of a failure', async () => {
    const step = stepDef('module.alpha.x', { shouldRun: async () => false });
    await setModule('alpha', null);
    await expect(advanceStep(paramsFor(db, step, taskId))).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(await stepRows()).toMatchObject([{ stepId: 'module.alpha.x', status: 'skipped' }]);
  });

  it('waits, on START, for a stamp still being committed, then fails the first step by name and runs no phase', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    setContainerCleanupRunner(async () => 0);
    Object.values(phases).forEach((phase) => phase.mockClear());
    await setModule('alpha', null);
    await db
      .insert(schema.taskTypeDefinitions)
      .values({
        slug: START_TYPE,
        displayName: 'Start guard',
        runListStrategy: 'static',
        stepIds: ['module.alpha.x'],
        source: 'admin',
      })
      .onConflictDoNothing();
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'start-guard', source: 'blank', storagePath: '/tmp/start-guard' })
      .returning();
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo!.id,
        type: START_TYPE,
        title: 'start',
        status: 'queued',
        runListSnapshot: ['module.alpha.x'],
      })
      .returning();
    const start = {
      id: 'job-start',
      name: TASK_JOB_NAMES.START,
      data: { taskId: made!.id, userId },
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    } as unknown as Job;

    const claimed = async () =>
      (
        await db
          .select({ status: schema.tasks.status })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, made!.id))
      )[0]?.status === 'running';
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let started!: Promise<void>;
    let raced: string | undefined;
    let during: { status: string; currentStepId: string | null } | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.modules)
        .where(eq(schema.modules.moduleId, 'alpha'))
        .for('update');
      await tx
        .update(schema.modules)
        .set({ deactivatedAt: OFF })
        .where(eq(schema.modules.moduleId, 'alpha'));
      started = processTaskJob(start, 'tok');
      for (let i = 0; i < 400 && !(await claimed()); i += 1) await pause(25);
      raced = await Promise.race([started.then(() => 'done'), pause(500).then(() => 'blocked')]);
      [during] = await db
        .select({ status: schema.tasks.status, currentStepId: schema.tasks.currentStepId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, made!.id));
    });
    expect(raced).toBe('blocked');
    expect(during).toEqual({ status: 'running', currentStepId: 'module.alpha.x' });
    await started;

    expect(phases.shouldRun).not.toHaveBeenCalled();
    expect(phases.detect).not.toHaveBeenCalled();
    expect(phases.apply).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, made!.id));
    expect(rows).toMatchObject([{ stepId: 'module.alpha.x', status: 'failed' }]);
    expectNamedReason(rows[0]?.errorMessage ?? '');
    const [after] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, made!.id));
    expect(after).toMatchObject({ status: 'failed', errorMessage: rows[0]?.errorMessage });
  });
});
