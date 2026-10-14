import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { advanceStep } from '../src/step-engine/step-runner.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const url = process.env.PENDING_FAIL_PATH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/pending_fail_path_test'))
  throw new Error('Use a dedicated pending_fail_path_test database for pending fail path tests');

const STEP_ID = 'pending-fail-path';
const BROKEN = 'the precondition read broke';

const KINDS = [
  {
    label: 'a step',
    extra: {},
    outcome: 'failed',
    rowStatus: 'failed',
    reports: { error: BROKEN },
  },
  {
    label: 'a fixLoopOnError step',
    extra: { fixLoopOnError: true },
    outcome: 'loop_back',
    rowStatus: 'done',
    reports: { diagnosis: BROKEN, sourceStepId: STEP_ID },
  },
] as const;

const throws = async (): Promise<never> => {
  throw new Error(BROKEN);
};

function stepDef(extra: Partial<StepDefinition> = {}): StepDefinition {
  return {
    metadata: {
      id: STEP_ID,
      workflowType: 'workflow',
      index: 0,
      title: STEP_ID,
      description: STEP_ID,
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

describe.skipIf(!url)('a step that throws before its pending row is opened, on Postgres', () => {
  const EMAIL_INDEX = 'pending-fail-path-test-user';
  let db: Database;
  let userId: string;
  let taskId: string;

  const advance = (step: StepDefinition) =>
    advanceStep({
      db,
      taskId,
      userId,
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      stepDef: step,
      providers: [],
      runSeq: 0,
      epoch: 0,
    });
  const stepRows = () =>
    db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId));
  const moveEpochOn = () =>
    db.update(schema.tasks).set({ orchestrationEpoch: 1 }).where(eq(schema.tasks.id, taskId));

  beforeAll(async () => {
    db = createDatabase(url as string);
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'pending-fail-path-test@test.local',
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
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'pending fail path' })
      .returning();
    taskId = task!.id;
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe.each(KINDS)('$label', ({ extra, outcome, rowStatus, reports }) => {
    it('records the thrown message when shouldRun throws on its pending row', async () => {
      await expect(advance(stepDef({ ...extra, shouldRun: throws }))).resolves.toMatchObject({
        status: outcome,
        ...reports,
        row: { status: rowStatus, errorMessage: BROKEN },
      });
      const [row] = await stepRows();
      expect(row).toMatchObject({
        status: rowStatus,
        errorMessage: BROKEN,
        statusMessage: null,
        startedAt: null,
      });
      expect(row?.endedAt).toBeInstanceOf(Date);
    });

    it('writes nothing when the task epoch moved on before shouldRun threw', async () => {
      const movedOn = async () => {
        await moveEpochOn();
        return throws();
      };
      await expect(advance(stepDef({ ...extra, shouldRun: movedOn }))).resolves.toMatchObject({
        status: 'superseded',
      });
      expect(await stepRows()).toMatchObject([
        { status: 'pending', errorMessage: null, endedAt: null },
      ]);
    });

    it('records a throw after the pass opened the row', async () => {
      await expect(
        advance(stepDef({ ...extra, shouldRun: () => true, detect: throws })),
      ).resolves.toMatchObject({
        status: outcome,
        ...reports,
        row: { status: rowStatus, errorMessage: BROKEN },
      });
      const [row] = await stepRows();
      expect(row).toMatchObject({ status: rowStatus, errorMessage: BROKEN });
      expect(row?.startedAt).toBeInstanceOf(Date);
    });
  });

  it('records a throw on a row that was already parked on a form', async () => {
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: STEP_ID,
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: STEP_ID,
      status: 'waiting_form',
    });
    await expect(advance(stepDef({ detect: throws }))).resolves.toMatchObject({
      status: 'failed',
      error: BROKEN,
      row: { status: 'failed', errorMessage: BROKEN },
    });
    expect(await stepRows()).toMatchObject([{ status: 'failed', errorMessage: BROKEN }]);
  });
});
