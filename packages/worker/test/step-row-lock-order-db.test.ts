import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { foldOtherTaskParks } from '../src/queues/cli-park-timing.js';

const url = process.env.WORKER_STEP_ROW_LOCK_ORDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worker_step_row_lock_order_test'))
  throw new Error(
    'Use a dedicated worker_step_row_lock_order_test database for the worker step row lock-order tests',
  );

// task_steps.id is a random uuid, so a worker write that takes the rows of one task in the order its
// caller lists them, or in the order a statement scans them, meets the api writers that lock by id
// (cancelOpenTasksForRepo) the wrong way round: it holds the higher id and waits for the lower one
// while the other holds the lower id and wants the higher (40P01).
//
// Every case seeds step rows A (lower id) and B (higher id), inserted B then A, with step ids that
// make every scan order (physical, task_id index, the unique task/step/round index) reach B first.
// The peer locks A and waits until the code under test is blocked on it, then locks B and commits.
// A write that takes its rows in id order waits for A holding nothing, so both finish.
const A = { id: '00000000-0000-4000-8000-0000000000a1', stepId: 'step-b' } as const;
const B = { id: '00000000-0000-4000-8000-0000000000b1', stepId: 'step-a' } as const;
const KEPT = { id: '00000000-0000-4000-8000-0000000000c1', stepId: 'step-c' } as const;
const NAMES: Record<string, string> = { [A.id]: 'A', [B.id]: 'B' };
const BLIND_INDEX = 'worker-step-row-lock-order-test-user';
const PARK_MESSAGE = 'Waiting for a free runtime slot';
const BLOCKED_WITHIN_MS = 10_000;
const SEED_ATTEMPTS = 10;
const TEST_TIMEOUT = 30_000;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Lock = (tx: Tx) => PromiseLike<unknown>;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepInsert = Partial<typeof schema.taskSteps.$inferInsert>;

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

const lockStepRow =
  (id: string): Lock =>
  (tx) =>
    tx
      .select({ id: schema.taskSteps.id })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, id))
      .for('no key update');

describe.skipIf(!url)(
  'worker multi-row step writes beside a peer that locks step rows in id order, on Postgres',
  () => {
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
          emailEncrypted: 'worker-step-row-lock-order-test@test.local',
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

    const seedTask = async (
      status: TaskStatus,
      over: Partial<typeof schema.tasks.$inferInsert> = {},
    ) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          type: 'workflow',
          title: 'worker step row lock order',
          status,
          orchestrationEpoch: 3,
          ...over,
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };

    const seedRow = async (
      taskId: string,
      row: typeof A | typeof B | typeof KEPT,
      over: StepInsert = {},
    ) => {
      await db.insert(schema.taskSteps).values({
        id: row.id,
        taskId,
        stepId: row.stepId,
        stepIndex: row === B ? 1 : 2,
        title: row.stepId,
        status: 'pending',
        ...over,
      });
    };

    /** Postgres may place a new row on an earlier page than the row inserted before it, so a pair that
     *  landed A first is removed and inserted again until a scan reaches B first. */
    const seedSteps = async (taskId: string, b: StepInsert, a: StepInsert) => {
      for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt++) {
        await db.delete(schema.taskSteps).where(inArray(schema.taskSteps.id, [A.id, B.id]));
        await seedRow(taskId, B, b);
        await seedRow(taskId, A, a);
        const scan = await db.execute<{ id: string }>(
          sql`select id from task_steps where task_id = ${taskId} order by ctid`,
        );
        const order = scan.map((row) => row.id).filter((id) => id === A.id || id === B.id);
        if (order.join() === [B.id, A.id].join()) return;
      }
      throw new Error('test setup: no scan order reached B before A');
    };

    const rowOf = async (id: string) =>
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
    const taskOf = async (id: string) =>
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;

    /** Step rows that someone holds right now; asked while the peer holds none of the rows asked about. */
    const stepRowsHeld = async (ids: string[]): Promise<string[]> => {
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
    };

    /** The peer takes `first`; once the code under test is blocked on it, the peer takes `second` and commits.
     *  `mustNotHold` are the step rows read while the code under test waits. */
    async function interleave<T>(
      codeUnderTest: () => Promise<T>,
      { first, second }: { first: Lock; second: Lock },
      mustNotHold: string[],
    ) {
      let peerHolds!: () => void;
      const holding = new Promise<void>((resolve) => (peerHolds = resolve));
      let proceed!: () => void;
      const proceeding = new Promise<void>((resolve) => (proceed = resolve));
      let peerPid = 0;
      let holdsFirst = false;
      const peerRun = settle(
        peer.transaction(async (tx) => {
          peerPid = await backendPid(tx);
          await first(tx);
          holdsFirst = true;
          peerHolds();
          await proceeding;
          await second(tx);
        }),
      );
      await Promise.race([holding, peerRun]);
      if (!holdsFirst) {
        const early = await peerRun;
        throw new Error(
          `the peer ended before holding its first lock: ${early.ok ? 'no error' : describeError(early.error)}`,
        );
      }

      let underTestEnded = false;
      const underTest = settle(codeUnderTest());
      void underTest.then(() => (underTestEnded = true));

      let heldWhileWaiting: string[] = [];
      try {
        const deadline = Date.now() + BLOCKED_WITHIN_MS;
        for (;;) {
          if (underTestEnded) {
            const early = await underTest;
            throw new Error(
              `the code under test ended without waiting for the peer: ${early.ok ? 'no error' : describeError(early.error)}`,
            );
          }
          const [row] = await db.execute<{ blocked: boolean }>(sql`
            select exists (
              select 1 from pg_stat_activity
              where wait_event_type = 'Lock' and ${peerPid}::int = any (pg_blocking_pids(pid))
            ) as blocked`);
          if (row?.blocked) break;
          if (Date.now() > deadline) {
            throw new Error(
              `the code under test was not blocked by the peer within ${BLOCKED_WITHIN_MS} ms`,
            );
          }
          await sleep(20);
        }
        heldWhileWaiting = await stepRowsHeld(mustNotHold);
      } finally {
        proceed();
        await Promise.all([peerRun, underTest]);
      }

      const [peerOutcome, underTestOutcome] = await Promise.all([peerRun, underTest]);
      return {
        failures: [
          ...(peerOutcome.ok ? [] : [`peer: ${describeError(peerOutcome.error)}`]),
          ...(underTestOutcome.ok
            ? []
            : [`code under test: ${describeError(underTestOutcome.error)}`]),
        ],
        heldWhileWaiting,
        result: underTestOutcome.ok ? underTestOutcome.value : undefined,
      };
    }

    const expectClean = ({
      failures,
      heldWhileWaiting,
    }: {
      failures: string[];
      heldWhileWaiting: string[];
    }) => {
      const held = heldWhileWaiting.map((id) => NAMES[id] ?? id).join(', ') || 'no step row';
      expect(
        failures,
        `while it waited, the code under test held ${held}; ${failures.join('; ') || 'nothing failed'}`,
      ).toEqual([]);
      expect(heldWhileWaiting, 'step rows the code under test held while it waited').toEqual([]);
    };

    const idOrderedPeer = { first: lockStepRow(A.id), second: lockStepRow(B.id) };

    it(
      'W1: resetStepAndDownstream over the target B and the downstream A waits for A without holding B',
      async () => {
        const taskId = await seedTask('running');
        await seedSteps(
          taskId,
          { status: 'failed', runSeq: 1, stepIndex: 1 },
          { status: 'done', runSeq: 2, stepIndex: 2 },
        );

        const run = await interleave(
          () => resetStepAndDownstream(db, taskId, B.stepId, 0),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect(run.result).toEqual({ downstreamReset: 1, newEpoch: 4 });
        expect((await rowOf(B.id)).status).toBe('pending');
        expect((await rowOf(A.id)).status).toBe('pending');
        expect((await taskOf(taskId)).orchestrationEpoch).toBe(4);
      },
      TEST_TIMEOUT,
    );

    it(
      'W2: foldOtherTaskParks over the parked B and A waits for A without holding B',
      async () => {
        const taskId = await seedTask('running');
        const parkedAt = new Date(Date.now() - 60_000);
        await seedRow(taskId, KEPT, { status: 'pending', waitingStartedAt: parkedAt });
        await seedSteps(
          taskId,
          { status: 'pending', waitingStartedAt: parkedAt, statusMessage: PARK_MESSAGE },
          { status: 'pending', waitingStartedAt: parkedAt, statusMessage: PARK_MESSAGE },
        );

        const run = await interleave(() => foldOtherTaskParks(db, taskId, KEPT.id), idOrderedPeer, [
          B.id,
        ]);

        expectClean(run);
        expect(await rowOf(B.id)).toMatchObject({ waitingStartedAt: null, statusMessage: null });
        expect(await rowOf(A.id)).toMatchObject({ waitingStartedAt: null, statusMessage: null });
        expect((await rowOf(KEPT.id)).waitingStartedAt).not.toBeNull();
      },
      TEST_TIMEOUT,
    );
  },
);
