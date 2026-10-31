import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';

const url = process.env.TASK_CANCEL_LOCK_ORDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_cancel_lock_order_test'))
  throw new Error(
    'Use a dedicated task_cancel_lock_order_test database for the task cancel lock-order tests',
  );

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000f2');
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
import { cancelTaskIfOpen } from '../src/lib/cancel-task.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import type { AppEnv } from '../src/context.js';

// cancelTaskRow ends every open step row of a task with one bulk UPDATE, which locks the rows in
// the order it scans them. task_steps.id is a random uuid, so that order meets a writer that locks
// by id (cancelOpenTasksForRepo) the wrong way round: the cancel holds the higher id and waits for
// the lower one while the other holds the lower id and wants the higher (40P01).
//
// The three cases seed two `pending` open rows, A (lower id) and B (higher id), inserted B then A,
// with step ids that make every scan order (physical, task_id index, the unique task/step/round
// index) reach B first. Pending rows with no park marker and no saved gate answer are ones Stop's
// failStuckSteps does not write, so before the Stop took the task's rows in id order it wrote no
// step row and the bulk UPDATE in cancelTaskRow was the first writer. The Stop's batch now keeps
// K7 and K8 clean: the Cancel route and the abort action both run a Stop first, and its
// lockStepRows takes every row of the task in id order before the cancel writes one. K8b calls
// cancelTaskIfOpen directly, with no Stop before it, so it is the case that pins cancelStillOpen's
// own batch.
// The peer locks A and waits until the code under test is blocked on it, then locks B and commits.
// Code that takes its rows in id order waits for A holding nothing, so both finish.
const A = { id: '00000000-0000-4000-8000-0000000000a1', stepId: 'step-b' } as const;
const B = { id: '00000000-0000-4000-8000-0000000000b1', stepId: 'step-a' } as const;
const NAMES: Record<string, string> = { [A.id]: 'A', [B.id]: 'B' };
const BLIND_INDEX = 'task-cancel-lock-order-test-user';
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

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
// Not the real errorHandler: it answers a 40P01 with a bare 500 and hides which error ended the route.
app.onError((err, c) => {
  h.thrown = err;
  return c.json({ error: 'the route threw' }, 500);
});

describe.skipIf(!url)(
  'the single-task cancel beside a peer that locks step rows in id order, on Postgres',
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
        emailEncrypted: 'task-cancel-lock-order-test@test.local',
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
          title: 'task cancel lock order',
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
        await seedRow(taskId, B, b);
        await seedRow(taskId, A, a);
        const scan = await db.execute<{ id: string }>(
          sql`select id from task_steps where task_id = ${taskId} order by ctid`,
        );
        if (scan.map((row) => row.id).join() === [B.id, A.id].join()) return;
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

    const expectCancelled = async (taskId: string) => {
      expect((await taskOf(taskId)).status).toBe('cancelled');
      expect(await rowOf(B.id)).toMatchObject({ status: 'failed', errorMessage: 'Task cancelled' });
      expect(await rowOf(A.id)).toMatchObject({ status: 'failed', errorMessage: 'Task cancelled' });
    };

    it(
      'K7: the Cancel route over two pending open rows B and A waits for A without holding B',
      async () => {
        const taskId = await seedTask('running');
        await seedSteps(taskId, { status: 'pending' }, { status: 'pending' });

        const run = await interleave(
          () => post(`/tasks/${taskId}/action`, { action: 'cancel' }),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect(run.result).toMatchObject({ status: 200, body: { ok: true, status: 'cancelled' } });
        await expectCancelled(taskId);
      },
      TEST_TIMEOUT,
    );

    it(
      'K8: the abort action (its Stop, then the cancel) over two pending open rows B and A waits for A without holding B',
      async () => {
        const taskId = await seedTask('running');
        await seedSteps(taskId, { status: 'pending' }, { status: 'pending' });

        const run = await interleave(
          () => post(`/tasks/${taskId}/steps/${B.stepId}/action`, { action: 'abort' }),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect(run.result).toMatchObject({ status: 200, body: { ok: true, status: 'cancelled' } });
        await expectCancelled(taskId);
      },
      TEST_TIMEOUT,
    );

    it(
      'K8b: cancelTaskIfOpen on its own, with no Stop before it, over two pending open rows B and A waits for A without holding B',
      async () => {
        const taskId = await seedTask('running');
        await seedSteps(taskId, { status: 'pending' }, { status: 'pending' });

        const run = await interleave(
          () => db.transaction((tx) => cancelTaskIfOpen(tx, taskId, { by: USER })),
          idOrderedPeer,
          [B.id],
        );

        expectClean(run);
        expect(run.result).toEqual({ cancelled: true });
        await expectCancelled(taskId);
      },
      TEST_TIMEOUT,
    );
  },
);
