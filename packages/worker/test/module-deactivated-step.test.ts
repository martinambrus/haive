import { eq, getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { moduleDeactivationMessage } from '../src/modules/activation.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { advanceStep, type AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

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
      expect(state.writes).toEqual(['update task_steps']);
      expect(state.patches[0]).toMatchObject({
        status: 'failed',
        statusMessage: null,
        errorMessage: error,
      });
      expect(state.patches[0]?.endedAt).toBeInstanceOf(Date);
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
      expect(state.writes).toEqual(['update task_steps']);
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
      expect(state.writes).toEqual(['update task_steps']);
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

  beforeAll(async () => {
    db = createDatabase(url as string);
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
    await db.delete(schema.modules);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
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

  it('writes a row for an active module, and none of a failure', async () => {
    const step = stepDef('module.alpha.x', { shouldRun: async () => false });
    await setModule('alpha', null);
    await expect(advanceStep(paramsFor(db, step, taskId))).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(await stepRows()).toMatchObject([{ stepId: 'module.alpha.x', status: 'skipped' }]);
  });
});
