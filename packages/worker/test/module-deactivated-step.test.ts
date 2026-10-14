import { eq, getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { assertModuleActive, ModuleDeactivatedError } from '../src/modules/activation.js';
import { advanceStep, type AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const url = process.env.MODULE_DEACTIVATED_STEP_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_deactivated_step_test'))
  throw new Error('Use a dedicated module_deactivated_step_test database for module step tests');

const OFF = new Date('2026-10-14T08:00:00.000Z');

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

interface MockState {
  modules: { deactivatedAt: Date | null }[];
  reads: string[];
  writes: string[];
}

const DONE_ROW = {
  id: 'ts-1',
  taskId: 'task-1',
  stepId: 'any',
  stepIndex: 0,
  round: 0,
  runSeq: 0,
  status: 'done',
  output: { ok: true },
  detectOutput: { ready: true },
};

function mockDb(state: MockState): Database {
  const write = (kind: string) => (table: unknown) => {
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
              name === 'modules' ? state.modules : name === 'task_steps' ? [DONE_ROW] : [],
          }),
        };
      },
    }),
    insert: write('insert'),
    update: write('update'),
    delete: write('delete'),
    query: { tasks: { findFirst: async () => ({ id: 'task-1', status: 'running' }) } },
  } as unknown as Database;
}

describe('advanceStep on a module step', () => {
  const run = (id: string, modules: MockState['modules']) => {
    const state: MockState = { modules, reads: [], writes: [] };
    return { state, result: advanceStep(paramsFor(mockDb(state), stepDef(id), 'task-1')) };
  };

  it('throws ModuleDeactivatedError before it touches any task step row', async () => {
    const { state, result } = run('module.alpha.x', [{ deactivatedAt: OFF }]);
    const err = await result.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ModuleDeactivatedError);
    expect((err as Error).message).toMatch(/alpha/);
    expect((err as Error).message).toMatch(/module\.alpha\.x/);
    expect((err as Error).message).toMatch(/reactivate/i);
    expect((err as Error).message).toMatch(/retry/i);
    expect(state.reads).toEqual(['modules']);
    expect(state.writes).toEqual([]);
  });

  it('goes on to the step row when the module is active', async () => {
    const { state, result } = run('module.alpha.x', [{ deactivatedAt: null }]);
    await expect(result).resolves.toMatchObject({ status: 'done' });
    expect(state.reads).toEqual(['modules', 'task_steps']);
  });

  it('goes on when the module has no row', async () => {
    const { state, result } = run('module.alpha.x', []);
    await expect(result).resolves.toMatchObject({ status: 'done' });
    expect(state.reads).toEqual(['modules', 'task_steps']);
  });

  it.each(['01-worktree-setup', 'term_step', 'custom.my-type.review'])(
    'issues no modules query for %s',
    async (id) => {
      const { state, result } = run(id, [{ deactivatedAt: OFF }]);
      await expect(result).resolves.toMatchObject({ status: 'done' });
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
  const stepRows = () =>
    db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));

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

  it('refuses a step of a deactivated module and no other', async () => {
    await setModule('alpha', OFF);
    await setModule('alpha-two', null);
    await expect(assertModuleActive(db, 'module.alpha.x')).rejects.toBeInstanceOf(
      ModuleDeactivatedError,
    );
    await expect(assertModuleActive(db, 'module.alpha-two.x')).resolves.toBeUndefined();
    await expect(assertModuleActive(db, 'module.ghost.x')).resolves.toBeUndefined();
  });

  it('reads no module row for a core or a custom step id', async () => {
    await setModule('alpha', OFF);
    await expect(assertModuleActive(db, '01-worktree-setup')).resolves.toBeUndefined();
    await expect(assertModuleActive(db, 'custom.alpha.review')).resolves.toBeUndefined();
  });

  it('writes no task step row for a deactivated module, and one for an active module', async () => {
    const step = stepDef('module.alpha.x', { shouldRun: async () => false });
    await setModule('alpha', OFF);
    await expect(advanceStep(paramsFor(db, step, taskId))).rejects.toBeInstanceOf(
      ModuleDeactivatedError,
    );
    expect(await stepRows()).toHaveLength(0);

    await db
      .update(schema.modules)
      .set({ deactivatedAt: null })
      .where(eq(schema.modules.moduleId, 'alpha'));
    await expect(advanceStep(paramsFor(db, step, taskId))).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(await stepRows()).toMatchObject([{ stepId: 'module.alpha.x', status: 'skipped' }]);
  });
});
