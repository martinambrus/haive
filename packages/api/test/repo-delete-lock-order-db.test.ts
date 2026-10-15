import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';
import { cancelOpenTasksForRepo } from '../src/lib/cancel-task.js';

const url = process.env.REPO_DELETE_LOCK_ORDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_delete_lock_order_test'))
  throw new Error(
    'Use a dedicated repo_delete_lock_order_test database for the repository delete lock-order tests',
  );

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Writes = (tx: Tx) => PromiseLike<unknown>;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];

const BLOCKED_WITHIN_MS = 10_000;

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

describe.skipIf(!url)('a repository delete racing a Retry or a worker claim, on Postgres', () => {
  let db: Database;
  let racer: Database;
  let userId: string;
  let repositoryId: string;

  beforeAll(() => {
    db = createDatabase(url as string);
    racer = createDatabase(url as string);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await racer.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'repo-delete-lock-order-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'repo delete lock order', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  async function seedTask(status: TaskStatus, steps: StepStatus[]) {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, repositoryId, type: 'workflow', title: 'lock order', status })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;
    const rows = await db
      .insert(schema.taskSteps)
      .values(
        steps.map((stepStatus, i) => ({
          taskId,
          stepId: `step-${i}`,
          stepIndex: i,
          title: `step ${i}`,
          status: stepStatus,
        })),
      )
      .returning({ id: schema.taskSteps.id });
    return { taskId, stepIds: rows.map((row) => row.id) };
  }

  async function stateOf(taskId: string) {
    const [task] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    const steps = await db
      .select({ status: schema.taskSteps.status, errorMessage: schema.taskSteps.errorMessage })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(schema.taskSteps.stepIndex);
    return { task: task!.status, steps };
  }

  const retryWrites = (taskId: string, stepId: string): { first: Writes; second: Writes } => ({
    first: (tx) =>
      tx
        .update(schema.taskSteps)
        .set({ status: 'pending', output: null, errorMessage: null, updatedAt: new Date() })
        .where(eq(schema.taskSteps.id, stepId)),
    second: (tx) =>
      tx
        .update(schema.tasks)
        .set({
          status: 'running',
          errorMessage: null,
          completedAt: null,
          orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, taskId)),
  });

  const claimWrites = (taskId: string, stepId: string): { first: Writes; second: Writes } => ({
    first: (tx) =>
      tx
        .update(schema.taskSteps)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.taskSteps.id, stepId), eq(schema.taskSteps.status, 'pending'))),
    second: (tx) =>
      tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .for('share'),
  });

  async function lockedTaskRows(): Promise<string[]> {
    const tasks = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.repositoryId, repositoryId));
    const held: string[] = [];
    for (const { id } of tasks) {
      await db
        .transaction((tx) =>
          tx
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(eq(schema.tasks.id, id))
            .for('update', { noWait: true }),
        )
        .catch((error: unknown) => {
          if (!isLockNotAvailable(error)) throw error;
          held.push(id);
        });
    }
    return held;
  }

  /** Racer holds `first`, the delete blocks on it, the racer then writes `second` and commits. */
  async function raceDelete({ first, second }: { first: Writes; second: Writes }) {
    let racerHolds!: () => void;
    const holding = new Promise<void>((resolve) => (racerHolds = resolve));
    let proceed!: () => void;
    const proceeding = new Promise<void>((resolve) => (proceed = resolve));
    let racerPid = 0;
    let holdsRow = false;
    const racerRun = settle(
      racer.transaction(async (tx) => {
        racerPid = await backendPid(tx);
        await first(tx);
        holdsRow = true;
        racerHolds();
        await proceeding;
        await second(tx);
      }),
    );
    await Promise.race([holding, racerRun]);
    if (!holdsRow) {
      const early = await racerRun;
      throw new Error(
        `the racer ended before holding its row: ${early.ok ? 'no error' : describeError(early.error)}`,
      );
    }

    let deletePid = 0;
    let deleteEnded = false;
    const deleteRun = settle(
      db.transaction(async (tx) => {
        deletePid = await backendPid(tx);
        return cancelOpenTasksForRepo(tx, repositoryId, userId);
      }),
    );
    void deleteRun.then(() => (deleteEnded = true));

    let heldTaskRows: string[] = [];
    try {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      for (;;) {
        if (deleteEnded) throw new Error('the delete ended without waiting for the racer');
        if (deletePid !== 0) {
          const [row] = await db.execute<{ blocked: boolean | null }>(sql`
            select (wait_event_type = 'Lock' and ${racerPid}::int = any (pg_blocking_pids(pid))) as blocked
            from pg_stat_activity
            where pid = ${deletePid}`);
          if (row?.blocked) break;
        }
        if (Date.now() > deadline) {
          throw new Error(`the delete was not blocked by the racer within ${BLOCKED_WITHIN_MS} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      heldTaskRows = await lockedTaskRows();
    } finally {
      proceed();
      await Promise.all([racerRun, deleteRun]);
    }

    const [racerOutcome, deleteOutcome] = await Promise.all([racerRun, deleteRun]);
    return {
      failures: [
        ...(racerOutcome.ok ? [] : [`racer: ${describeError(racerOutcome.error)}`]),
        ...(deleteOutcome.ok ? [] : [`repository delete: ${describeError(deleteOutcome.error)}`]),
      ],
      cancelled: deleteOutcome.ok ? deleteOutcome.value : [],
      heldTaskRows,
    };
  }

  it('finishes beside a Retry that writes a step row and then the task row', async () => {
    const { taskId, stepIds } = await seedTask('running', ['failed', 'pending']);

    const { failures, cancelled, heldTaskRows } = await raceDelete(
      retryWrites(taskId, stepIds[1]!),
    );

    expect(failures).toEqual([]);
    expect(heldTaskRows, 'task rows the delete held while it waited').toEqual([]);
    expect(cancelled).toEqual([{ id: taskId }]);
    const state = await stateOf(taskId);
    expect(state.task).toBe('cancelled');
    expect(state.steps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(state.steps[1]!.errorMessage).toBe('Task cancelled');
  }, 30_000);

  it('finishes beside a worker claim that flips a step row and then reads the task row', async () => {
    const { taskId, stepIds } = await seedTask('running', ['failed', 'pending']);

    const { failures, cancelled, heldTaskRows } = await raceDelete(
      claimWrites(taskId, stepIds[1]!),
    );

    expect(failures).toEqual([]);
    expect(heldTaskRows, 'task rows the delete held while it waited').toEqual([]);
    expect(cancelled).toEqual([{ id: taskId }]);
    const state = await stateOf(taskId);
    expect(state.task).toBe('cancelled');
    expect(state.steps.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(state.steps[1]!.errorMessage).toBe('Task cancelled');
  }, 30_000);

  it('cancels both tasks when the racer holds a step row of the second one', async () => {
    const first = await seedTask('running', ['pending']);
    const second = await seedTask('running', ['failed', 'pending']);

    const { failures, cancelled, heldTaskRows } = await raceDelete(
      retryWrites(second.taskId, second.stepIds[1]!),
    );

    expect(failures).toEqual([]);
    expect(heldTaskRows, 'task rows the delete held while it waited').toEqual([]);
    expect(cancelled.map((task) => task.id).sort()).toEqual([first.taskId, second.taskId].sort());
    expect(await stateOf(first.taskId)).toMatchObject({
      task: 'cancelled',
      steps: [{ status: 'failed' }],
    });
    expect(await stateOf(second.taskId)).toMatchObject({
      task: 'cancelled',
      steps: [{ status: 'failed' }, { status: 'failed' }],
    });
  }, 30_000);

  it('returns nothing and writes nothing when no task is open', async () => {
    await seedTask('completed', ['done', 'pending']);
    await seedTask('failed', ['failed', 'pending']);
    const snapshot = async () => ({
      tasks: await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.repositoryId, repositoryId))
        .orderBy(schema.tasks.id),
      steps: await db
        .select({ step: schema.taskSteps })
        .from(schema.taskSteps)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
        .where(eq(schema.tasks.repositoryId, repositoryId))
        .orderBy(schema.taskSteps.id),
      events: await db
        .select({ event: schema.taskEvents })
        .from(schema.taskEvents)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskEvents.taskId))
        .where(eq(schema.tasks.repositoryId, repositoryId))
        .orderBy(schema.taskEvents.id),
    });
    const before = await snapshot();

    const cancelled = await db.transaction((tx) =>
      cancelOpenTasksForRepo(tx, repositoryId, userId),
    );

    expect(cancelled).toEqual([]);
    expect(await snapshot()).toEqual(before);
  }, 30_000);
});
