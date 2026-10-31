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
import { cancelOpenTasksForRepo, cancelTaskIfOpen } from '../src/lib/cancel-task.js';

const url = process.env.TASK_CANCEL_LATE_ROW_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_cancel_late_row_test'))
  throw new Error(
    'Use a dedicated task_cancel_late_row_test database for the late-row cancel tests',
  );

// A cancel locks the step rows its tasks have in one batch, then the task rows, then ends the open
// step rows with a bulk UPDATE. A step row created and committed after the batch is not held by
// it. A bulk UPDATE that reached that row would lock it in scan order, while a worker's claim of
// the row (`openPendingStep`: it flips the row, then reads the task row FOR SHARE) holds it and
// waits for the task row the cancel holds: each wants what the other has (40P01). The bulk
// UPDATE therefore ends only the rows the batch locked, and the CANCEL job queued after the commit
// ends a row created later.
//
// Every case runs the same interleave. A gate holds the task row FOR NO KEY UPDATE, which the
// KEY SHARE of an insert's foreign key does not wait for, so the cancel takes its batch and then
// waits at the task row. While it waits, a step row is created and committed for the task and a
// claim flips it and waits for the task row, behind the cancel. Then the gate commits.
const BLOCKED_WITHIN_MS = 10_000;
const TEST_TIMEOUT = 30_000;
const LATE_STEP_ID = 'step-late';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

describe.skipIf(!url)('a cancel beside a step row created after its batch, on Postgres', () => {
  let db: Database;
  let gate: Database;
  let claimer: Database;
  let userId: string;
  let repositoryId: string;

  beforeAll(() => {
    db = createDatabase(url as string);
    gate = createDatabase(url as string);
    claimer = createDatabase(url as string);
  });

  afterAll(async () => {
    for (const handle of [db, gate, claimer]) await handle.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'task-cancel-late-row-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'task cancel late row', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  async function seedTask(status: TaskStatus, steps: StepStatus[]) {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, repositoryId, type: 'workflow', title: 'late row', status })
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
      .select({
        id: schema.taskSteps.id,
        status: schema.taskSteps.status,
        errorMessage: schema.taskSteps.errorMessage,
        endedAt: schema.taskSteps.endedAt,
      })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(schema.taskSteps.stepIndex);
    return { task: task!.status, steps };
  }

  /** Step rows that someone holds right now; asked while the code under test waits. */
  async function stepRowsHeld(ids: string[]): Promise<string[]> {
    const held: string[] = [];
    for (const id of ids) {
      await db
        .transaction((tx) =>
          tx
            .select({ id: schema.taskSteps.id })
            .from(schema.taskSteps)
            .where(eq(schema.taskSteps.id, id))
            .for('no key update', { noWait: true }),
        )
        .catch((error: unknown) => {
          if (!isLockNotAvailable(error)) throw error;
          held.push(id);
        });
    }
    return held;
  }

  /** Polls until the backend `pid()` waits on a lock, held by `blocker` when one is given. */
  async function waitForLockWait(
    pid: () => number,
    ended: () => boolean,
    what: string,
    blocker = 0,
  ) {
    const deadline = Date.now() + BLOCKED_WITHIN_MS;
    for (;;) {
      if (ended()) throw new Error(`${what} ended without waiting on a lock`);
      if (pid() !== 0) {
        const [row] = await db.execute<{ blocked: boolean | null }>(sql`
          select (wait_event_type = 'Lock'
                  and (${blocker}::int = 0 or ${blocker}::int = any (pg_blocking_pids(pid)))) as blocked
          from pg_stat_activity
          where pid = ${pid()}`);
        if (row?.blocked) return;
      }
      if (Date.now() > deadline) {
        throw new Error(`${what} was not waiting on a lock within ${BLOCKED_WITHIN_MS} ms`);
      }
      await pause(20);
    }
  }

  /** The gate holds the task row of `lateTaskId`; `cancel` runs in a transaction and waits there
   *  after its batch (`lockedStepIds` are the rows it must hold by then); a step row is created and
   *  claimed for that task meanwhile; then the gate commits. */
  async function cancelBesideLateRow<T>(opts: {
    lateTaskId: string;
    lockedStepIds: string[];
    cancel: (tx: Tx) => PromiseLike<T>;
  }) {
    const { lateTaskId, lockedStepIds, cancel } = opts;
    let gatePid = 0;
    let gateHolds = false;
    let gateReady!: () => void;
    const gateIsReady = new Promise<void>((resolve) => (gateReady = resolve));
    let openGate!: () => void;
    const gateOpened = new Promise<void>((resolve) => (openGate = resolve));
    const gateRun = settle(
      gate.transaction(async (tx) => {
        gatePid = await backendPid(tx);
        await tx
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, lateTaskId))
          .for('no key update');
        gateHolds = true;
        gateReady();
        await gateOpened;
      }),
    );
    await Promise.race([gateIsReady, gateRun]);
    if (!gateHolds) {
      const early = await gateRun;
      throw new Error(
        `the gate ended before holding the task row: ${early.ok ? 'no error' : describeError(early.error)}`,
      );
    }

    let cancelPid = 0;
    let cancelEnded = false;
    const cancelRun = settle(
      db.transaction(async (tx) => {
        cancelPid = await backendPid(tx);
        return cancel(tx);
      }),
    );
    void cancelRun.then(() => (cancelEnded = true));

    let claimPid = 0;
    let claimRun: Promise<Outcome<void>> | undefined;
    let heldAtGate: string[] = [];
    let lateStepId = '';
    try {
      await waitForLockWait(
        () => cancelPid,
        () => cancelEnded,
        'the cancel',
        gatePid,
      );
      heldAtGate = await stepRowsHeld(lockedStepIds);
      const [late] = await claimer
        .insert(schema.taskSteps)
        .values({
          taskId: lateTaskId,
          stepId: LATE_STEP_ID,
          stepIndex: 99,
          title: 'created after the batch',
          status: 'pending',
        })
        .returning({ id: schema.taskSteps.id });
      lateStepId = late!.id;
      claimRun = settle(
        claimer.transaction(async (tx) => {
          claimPid = await backendPid(tx);
          await tx
            .update(schema.taskSteps)
            .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
            .where(
              and(eq(schema.taskSteps.id, lateStepId), eq(schema.taskSteps.status, 'pending')),
            );
          await tx
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(eq(schema.tasks.id, lateTaskId))
            .for('share');
        }),
      );
      await waitForLockWait(
        () => claimPid,
        () => false,
        'the claim',
      );
    } finally {
      openGate();
      await Promise.all([gateRun, cancelRun, claimRun]);
    }

    const [gateOutcome, cancelOutcome, claimOutcome] = await Promise.all([
      gateRun,
      cancelRun,
      claimRun,
    ]);
    return {
      failures: [
        ...(gateOutcome.ok ? [] : [`gate: ${describeError(gateOutcome.error)}`]),
        ...(cancelOutcome.ok ? [] : [`cancel: ${describeError(cancelOutcome.error)}`]),
        ...(claimOutcome?.ok === false ? [`claim: ${describeError(claimOutcome.error)}`] : []),
      ],
      heldAtGate,
      lateStepId,
      result: cancelOutcome.ok ? cancelOutcome.value : undefined,
    };
  }

  it(
    'the single-task cancel ends the rows it locked and leaves a row created after its batch',
    async () => {
      const { taskId, stepIds } = await seedTask('running', ['running', 'pending']);

      const run = await cancelBesideLateRow({
        lateTaskId: taskId,
        lockedStepIds: stepIds,
        cancel: (tx) => cancelTaskIfOpen(tx, taskId, { by: userId }),
      });

      expect(run.failures).toEqual([]);
      expect(run.heldAtGate.sort(), 'step rows the cancel held while it waited').toEqual(
        [...stepIds].sort(),
      );
      expect(run.result).toEqual({ cancelled: true });
      const state = await stateOf(taskId);
      expect(state.task).toBe('cancelled');
      expect(state.steps.slice(0, 2)).toMatchObject([
        { status: 'failed', errorMessage: 'Task cancelled' },
        { status: 'failed', errorMessage: 'Task cancelled' },
      ]);
      // The claim flipped the new row and went on once the cancel committed; the cancel never wrote it.
      expect(state.steps[2]).toMatchObject({
        id: run.lateStepId,
        status: 'running',
        errorMessage: null,
        endedAt: null,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "the repository delete's cancel ends the rows it locked and leaves a row created after its batch",
    async () => {
      const { taskId, stepIds } = await seedTask('running', ['running', 'pending']);

      const run = await cancelBesideLateRow({
        lateTaskId: taskId,
        lockedStepIds: stepIds,
        cancel: (tx) => cancelOpenTasksForRepo(tx, repositoryId, userId),
      });

      expect(run.failures).toEqual([]);
      expect(run.heldAtGate.sort(), 'step rows the cancel held while it waited').toEqual(
        [...stepIds].sort(),
      );
      expect(run.result).toEqual([{ id: taskId }]);
      const state = await stateOf(taskId);
      expect(state.task).toBe('cancelled');
      expect(state.steps.slice(0, 2)).toMatchObject([
        { status: 'failed', errorMessage: 'Task cancelled' },
        { status: 'failed', errorMessage: 'Task cancelled' },
      ]);
      expect(state.steps[2]).toMatchObject({
        id: run.lateStepId,
        status: 'running',
        errorMessage: null,
        endedAt: null,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "a cancel of two tasks ends each one's locked rows and leaves a row created in the second",
    async () => {
      const first = await seedTask('running', ['pending']);
      const second = await seedTask('running', ['running', 'pending']);

      const run = await cancelBesideLateRow({
        lateTaskId: second.taskId,
        lockedStepIds: [...first.stepIds, ...second.stepIds],
        cancel: (tx) => cancelOpenTasksForRepo(tx, repositoryId, userId),
      });

      expect(run.failures).toEqual([]);
      expect(run.heldAtGate.sort(), 'step rows the cancel held while it waited').toEqual(
        [...first.stepIds, ...second.stepIds].sort(),
      );
      expect((run.result ?? []).map((task) => task.id).sort()).toEqual(
        [first.taskId, second.taskId].sort(),
      );
      const firstState = await stateOf(first.taskId);
      expect(firstState.task).toBe('cancelled');
      expect(firstState.steps).toMatchObject([
        { status: 'failed', errorMessage: 'Task cancelled' },
      ]);
      const secondState = await stateOf(second.taskId);
      expect(secondState.task).toBe('cancelled');
      expect(secondState.steps.slice(0, 2)).toMatchObject([
        { status: 'failed', errorMessage: 'Task cancelled' },
        { status: 'failed', errorMessage: 'Task cancelled' },
      ]);
      expect(secondState.steps[2]).toMatchObject({
        id: run.lateStepId,
        status: 'running',
        errorMessage: null,
        endedAt: null,
      });
    },
    TEST_TIMEOUT,
  );
});
