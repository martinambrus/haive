import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';

const url = process.env.WORKER_STEP_FOLD_PREREAD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worker_step_fold_preread_test'))
  throw new Error(
    'Use a dedicated worker_step_fold_preread_test database for the worker step fold tests',
  );

// A worker fold adds a delta to task_steps.carried_work_ms / carried_idle_ms / carried_user_active_ms, and
// the delta comes from the row (computeFoldContribution reads its status, bounds, live idle_ms and
// user_active_ms). A fold that reads the row before the transaction that writes it overwrites whatever lands
// in between. Every case seeds one step row; a peer adds to its carried_* and to its live idle_ms and holds
// the row; the code under test starts, and the peer commits once the code under test is blocked on it. The
// final carried_* must be the seed + the peer + the fold of the row the peer left.
const STEP_ID = '02-fold-preread';
const BLIND_INDEX = 'worker-step-fold-preread-test-user';
const BLOCKED_WITHIN_MS = 10_000;
const TEST_TIMEOUT = 30_000;

const SEED = { work: 1000, idle: 200, user: 50, liveIdle: 4000, liveUser: 800 } as const;
const PEER = { work: 7000, idle: 3000, user: 500, liveIdle: 2000 } as const;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type StepInsert = Partial<typeof schema.taskSteps.$inferInsert>;

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

describe.skipIf(!url)('worker step folds beside a peer that updates the row, on Postgres', () => {
  let db: Database;
  let peer: Database;
  let userId: string;

  beforeAll(async () => {
    db = createDatabase(url as string);
    peer = createDatabase(url as string);
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'worker-step-fold-preread-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: 'not-real',
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
  });

  beforeEach(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
    await peer.$client.end({ timeout: 5 });
  });

  const seedTask = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'worker step fold preread',
        status: 'running',
        orchestrationEpoch: 3,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    return task!.id;
  };

  const seedRow = async (taskId: string, over: StepInsert = {}) => {
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: STEP_ID,
        stepIndex: 1,
        runSeq: 1,
        round: 0,
        title: STEP_ID,
        status: 'pending',
        idleMs: SEED.liveIdle,
        userActiveMs: SEED.liveUser,
        carriedWorkMs: SEED.work,
        carriedIdleMs: SEED.idle,
        carriedUserActiveMs: SEED.user,
        ...over,
      })
      .returning({ id: schema.taskSteps.id });
    return row!.id;
  };

  const rowOf = async (id: string) =>
    (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;

  const carriedOf = (row: typeof schema.taskSteps.$inferSelect) => ({
    work: row.carriedWorkMs,
    idle: row.carriedIdleMs,
    user: row.carriedUserActiveMs,
  });

  /** The peer adds PEER to the row's carried_* and live idle_ms and holds the row. Once the code under test is
   *  blocked on the peer's transaction, the peer commits. Answers what the code under test answered. */
  async function whilePeerHoldsRow<T>(rowId: string, codeUnderTest: () => Promise<T>): Promise<T> {
    let peerHolds!: () => void;
    const holding = new Promise<void>((resolve) => (peerHolds = resolve));
    let proceed!: () => void;
    const proceeding = new Promise<void>((resolve) => (proceed = resolve));
    let peerPid = 0;
    let holdsRow = false;
    const peerRun = settle(
      peer.transaction(async (tx) => {
        peerPid = await backendPid(tx);
        await tx.execute(sql`
          update task_steps set
            carried_work_ms = carried_work_ms + ${PEER.work},
            carried_idle_ms = carried_idle_ms + ${PEER.idle},
            carried_user_active_ms = carried_user_active_ms + ${PEER.user},
            idle_ms = idle_ms + ${PEER.liveIdle}
          where id = ${rowId}`);
        holdsRow = true;
        peerHolds();
        await proceeding;
      }),
    );
    await Promise.race([holding, peerRun]);
    if (!holdsRow) {
      const early = await peerRun;
      throw new Error(
        `the peer ended before holding the row: ${early.ok ? 'no error' : String(early.error)}`,
      );
    }

    let underTestEnded = false;
    const underTest = settle(codeUnderTest());
    void underTest.then(() => (underTestEnded = true));
    try {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      for (;;) {
        if (underTestEnded) {
          const early = await underTest;
          throw new Error(
            `the code under test ended without waiting for the peer: ${early.ok ? 'no error' : String(early.error)}`,
          );
        }
        const [blocked] = await db.execute<{ blocked: boolean }>(sql`
          select exists (
            select 1 from pg_stat_activity
            where wait_event_type = 'Lock' and ${peerPid}::int = any (pg_blocking_pids(pid))
          ) as blocked`);
        if (blocked?.blocked) break;
        if (Date.now() > deadline) {
          throw new Error(
            `the code under test was not blocked by the peer within ${BLOCKED_WITHIN_MS} ms`,
          );
        }
        await sleep(20);
      }
    } finally {
      proceed();
      await Promise.all([peerRun, underTest]);
    }

    const [peerOutcome, underTestOutcome] = await Promise.all([peerRun, underTest]);
    if (!peerOutcome.ok) throw new Error(`peer: ${String(peerOutcome.error)}`);
    if (!underTestOutcome.ok) throw underTestOutcome.error;
    return underTestOutcome.value;
  }

  it(
    'G1: resetStepAndDownstream folds the row the peer left, not the row it read before its transaction',
    async () => {
      const taskId = await seedTask();
      const rowId = await seedRow(taskId, {
        status: 'done',
        startedAt: new Date('2026-10-30T10:00:00.000Z'),
        endedAt: new Date('2026-10-30T10:01:00.000Z'),
      });

      const result = await whilePeerHoldsRow(rowId, () =>
        resetStepAndDownstream(db, taskId, STEP_ID, 0),
      );

      expect(result).toEqual({ downstreamReset: 0, newEpoch: 4 });
      const row = await rowOf(rowId);
      expect(row).toMatchObject({ status: 'pending', idleMs: 0, userActiveMs: 0 });
      // seed 1000/200/50 + peer 7000/3000/500 + the fold of the row the peer left: a 60 s run with idle
      // 4000 + 2000 and user 800 is work 54000, idle 6000, user 800. The row read before the peer
      // committed folds 56000/4000/800 and writes 57000/4200/850, taking back everything the peer added.
      expect(carriedOf(row), 'carried_* after the peer and the fold').toEqual({
        work: 62_000,
        idle: 9_200,
        user: 1_350,
      });
    },
    TEST_TIMEOUT,
  );
});
