import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';

const url = process.env.STEP_ROW_LOCK_ORDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_row_lock_order_test'))
  throw new Error(
    'Use a dedicated step_row_lock_order_test database for the step row lock-order tests',
  );

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000f1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
  thrown: undefined as unknown,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, payload: unknown) => {
      h.queued.push({ name, payload });
    },
  });
  return {
    getTaskQueue: queue,
    getRepoQueue: queue,
    getBundleQueue: queue,
    getCliExecQueue: queue,
    getUsagePollQueue: queue,
  };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async () => null,
      getBoolean: async () => false,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
      set: async () => undefined,
    },
  };
});

import { Hono } from 'hono';
import { TASK_JOB_NAMES } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { resetRowsForRerun, retryTaskAtStep } from '../src/routes/tasks/steps.js';
import { settleActiveSteps, supersedeLiveRuns } from '../src/lib/task-control.js';
import type { AppEnv } from '../src/context.js';

// task_steps.id is a random uuid, so a writer that takes the rows of one task in the order its
// caller lists them, or in the order a statement scans them, meets the writers that lock by id
// (cancelOpenTasksForRepo) the wrong way round: it holds the higher id and waits for the lower one
// while the other holds the lower id and wants the higher (40P01).
//
// Every case seeds step rows A (lower id) and B (higher id), inserted B then A, with step ids that
// make every scan order (physical, task_id index, the unique task/step/round index) reach B first.
// The peer locks A and waits until the code under test is blocked on it, then locks B and commits.
// A writer that takes its rows in id order waits for A holding nothing, so both finish. K2 and K9
// are the exceptions: their peer holds a run row first and then wants a step row, as a pass does.
const A = { id: '00000000-0000-4000-8000-0000000000a1', stepId: 'step-b' } as const;
const B = { id: '00000000-0000-4000-8000-0000000000b1', stepId: 'step-a' } as const;
const RUN = '00000000-0000-4000-8000-0000000000c1';
const NAMES: Record<string, string> = { [A.id]: 'A', [B.id]: 'B' };
// A step id that opts into the Skip action (SKIPPABLE_STEP_IDS).
const SKIPPABLE = '11b-kb-commit';
const BLIND_INDEX = 'step-row-lock-order-test-user';
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
  (id: string, mode: 'update' | 'no key update' = 'no key update'): Lock =>
  (tx) =>
    tx
      .select({ id: schema.taskSteps.id })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, id))
      .for(mode);

const lockRun =
  (id: string): Lock =>
  (tx) =>
    tx
      .select({ id: schema.cliInvocations.id })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, id))
      .for('update');

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
// Not the real errorHandler: it answers a 40P01 with a bare 500 and hides which error ended the route.
app.onError((err, c) => {
  h.thrown = err;
  return c.json({ error: 'the route threw' }, 500);
});

describe.skipIf(!url)(
  'multi-row step writers beside a peer that locks step rows in id order, on Postgres',
  () => {
    let db: Database;
    let peer: Database;

    beforeAll(async () => {
      db = createDatabase(url as string);
      peer = createDatabase(url as string);
      h.db = db;
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.insert(schema.users).values({
        id: USER,
        emailEncrypted: 'step-row-lock-order-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: 'not-real',
        role: 'user',
      });
    });

    beforeEach(async () => {
      h.queued = [];
      h.thrown = undefined;
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
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
          userId: USER,
          type: 'workflow',
          title: 'step row lock order',
          status,
          orchestrationEpoch: 3,
          ...over,
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };

    const seedRow = async (taskId: string, row: typeof A | typeof B, over: StepInsert = {}) => {
      const [made] = await db
        .insert(schema.taskSteps)
        .values({
          id: row.id,
          taskId,
          stepId: row.stepId,
          stepIndex: row === B ? 1 : 2,
          title: row.stepId,
          status: 'pending',
          ...over,
        })
        .returning();
      return made!;
    };

    /** Postgres may place a new row on an earlier page than the row inserted before it, so a pair that
     *  landed A first is removed and inserted again until a scan reaches B first. */
    const seedSteps = async (taskId: string, b: StepInsert, a: StepInsert) => {
      for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt++) {
        await db.delete(schema.taskSteps).where(inArray(schema.taskSteps.id, [A.id, B.id]));
        const rowB = await seedRow(taskId, B, b);
        const rowA = await seedRow(taskId, A, a);
        const scan = await db.execute<{ id: string }>(
          sql`select id from task_steps where task_id = ${taskId} order by ctid`,
        );
        if (scan.map((row) => row.id).join() === [B.id, A.id].join()) return { rowB, rowA };
      }
      throw new Error('test setup: no scan order reached B before A');
    };

    const rowOf = async (id: string) =>
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
    const taskOf = async (id: string) =>
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;
    const runOf = async (id: string) =>
      (await db.query.cliInvocations.findFirst({ where: eq(schema.cliInvocations.id, id) }))!;

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

    const post = async (path: string, body: Record<string, unknown>) => {
      h.thrown = undefined;
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (h.thrown !== undefined) throw h.thrown;
      return { status: res.status, body: (await res.json()) as unknown };
    };

    it(
      'K1: resetRowsForRerun over [B, A] waits for A without holding B, so a peer taking A then B does not deadlock it',
      async () => {
        const taskId = await seedTask('failed');
        const { rowB, rowA } = await seedSteps(taskId, { status: 'failed' }, { status: 'failed' });

        const run = await interleave(
          () => db.transaction((tx) => resetRowsForRerun(tx, taskId, [rowB, rowA], new Date())),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect((await rowOf(B.id)).status).toBe('pending');
        expect((await rowOf(A.id)).status).toBe('pending');
      },
      TEST_TIMEOUT,
    );

    it(
      'K2: resetRowsForRerun sweeps the runs of its rows before it holds the step row, so a pass holding a run and wanting the step row does not deadlock it',
      async () => {
        const taskId = await seedTask('failed');
        const rowB = await seedRow(taskId, B, { status: 'failed' });
        await db
          .insert(schema.cliInvocations)
          .values({ id: RUN, taskId, taskStepId: B.id, mode: 'cli', prompt: 'a live run of B' });

        const run = await interleave(
          () => db.transaction((tx) => resetRowsForRerun(tx, taskId, [rowB], new Date())),
          { first: lockRun(RUN), second: lockStepRow(B.id, 'update') },
          [B.id],
        );

        expectClean(run);
        expect((await rowOf(B.id)).status).toBe('pending');
        expect((await runOf(RUN)).supersededAt).not.toBeNull();
      },
      TEST_TIMEOUT,
    );

    it(
      'K3: Retry of a failed task that resets B and re-offers the parked A waits for A without holding B',
      async () => {
        const taskId = await seedTask('failed', { currentStepId: B.stepId, currentRound: 0 });
        const { rowB } = await seedSteps(
          taskId,
          { status: 'failed', runSeq: 2, stepIndex: 2 },
          {
            status: 'waiting_form',
            runSeq: 1,
            stepIndex: 1,
            waitingStartedAt: new Date(Date.now() - 60_000),
          },
        );

        const run = await interleave(() => retryTaskAtStep(db, taskId, USER, rowB), idOrderedPeer, [
          B.id,
        ]);

        expectClean(run);
        expect((await rowOf(B.id)).status).toBe('pending');
        expect(await rowOf(A.id)).toMatchObject({ status: 'pending', waitingStartedAt: null });
        expect((await taskOf(taskId)).status).toBe('running');
        expect(h.queued).toMatchObject([
          {
            name: TASK_JOB_NAMES.ADVANCE_STEP,
            payload: { taskId, stepId: B.stepId, round: 0, epoch: 4 },
          },
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      'K4: supersedeLiveRuns over the running B and A waits for A without holding B',
      async () => {
        const taskId = await seedTask('running');
        await seedSteps(taskId, { status: 'running' }, { status: 'running' });

        const run = await interleave(
          () => db.transaction((tx) => supersedeLiveRuns(tx, taskId, { failTask: false })),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect(run.result).toMatchObject({ cancelled: 0, stopped: 2 });
        expect(await rowOf(B.id)).toMatchObject({
          status: 'failed',
          errorMessage: 'Stopped by user',
        });
        expect(await rowOf(A.id)).toMatchObject({
          status: 'failed',
          errorMessage: 'Stopped by user',
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'K5: settleActiveSteps over the running B and the parked A waits for A without holding B',
      async () => {
        const taskId = await seedTask('failed');
        await seedSteps(
          taskId,
          { status: 'running' },
          { status: 'waiting_form', waitingStartedAt: new Date(Date.now() - 60_000) },
        );

        const run = await interleave(() => settleActiveSteps(db, taskId), idOrderedPeer, [B.id]);

        expectClean(run);
        expect(await rowOf(B.id)).toMatchObject({
          status: 'failed',
          errorMessage: 'Stopped by user',
        });
        expect(await rowOf(A.id)).toMatchObject({ status: 'pending', waitingStartedAt: null });
      },
      TEST_TIMEOUT,
    );

    it(
      'K6: the Skip route over the failed B with A left active waits for A without holding B',
      async () => {
        const taskId = await seedTask('failed', { currentStepId: SKIPPABLE, currentRound: 0 });
        await seedSteps(taskId, { stepId: SKIPPABLE, status: 'failed' }, { status: 'running' });

        const run = await interleave(
          () => post(`/tasks/${taskId}/steps/${SKIPPABLE}/action`, { action: 'skip' }),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect(run.result).toMatchObject({ status: 200, body: { ok: true, status: 'skipped' } });
        expect((await rowOf(B.id)).status).toBe('skipped');
        expect((await rowOf(A.id)).status).toBe('pending');
        expect((await taskOf(taskId)).status).toBe('running');
      },
      TEST_TIMEOUT,
    );

    it(
      'K9: the Skip route with the running A left active sweeps the runs of A before it holds a step row, so a pass holding a run and wanting A does not deadlock it',
      async () => {
        const taskId = await seedTask('failed', { currentStepId: SKIPPABLE, currentRound: 0 });
        await seedSteps(taskId, { stepId: SKIPPABLE, status: 'failed' }, { status: 'running' });
        await db
          .insert(schema.cliInvocations)
          .values({ id: RUN, taskId, taskStepId: A.id, mode: 'cli', prompt: 'a live run of A' });

        const run = await interleave(
          () => post(`/tasks/${taskId}/steps/${SKIPPABLE}/action`, { action: 'skip' }),
          { first: lockRun(RUN), second: lockStepRow(A.id, 'update') },
          [A.id, B.id],
        );

        expectClean(run);
        expect(run.result).toMatchObject({ status: 200, body: { ok: true, status: 'skipped' } });
        expect((await rowOf(B.id)).status).toBe('skipped');
        expect((await rowOf(A.id)).status).toBe('pending');
        expect((await runOf(RUN)).supersededAt).not.toBeNull();
        expect((await taskOf(taskId)).status).toBe('running');
      },
      TEST_TIMEOUT,
    );
  },
);
