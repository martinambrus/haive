import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.STEP_FOLD_PREREAD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_fold_preread_test'))
  throw new Error(
    'Use a dedicated step_fold_preread_test database for the step fold pre-read tests',
  );

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000f2');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({ add: async () => undefined });
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

import { PROVIDER_SENSITIVE_STEP_IDS } from '@haive/shared';
import { resetRowsForRerun } from '../src/routes/tasks/steps.js';

// Every case seeds one step row with live idle_ms 4000 and user_active_ms 800 and carried work / idle /
// user of 1000 / 200 / 50. A peer transaction on a second connection adds 7000 / 3000 / 500 to
// carried_* and 2000 to idle_ms and holds the row. The writer under test starts, is seen waiting for the
// peer, and the peer commits. The writer must fold the row as the peer left it (idle_ms 6000), so the
// final carried_* is the seed, plus the peer's share, plus that fold. A writer that folds the row it
// read before the peer's commit writes carried_* without the peer's share.
const STEP = {
  id: '00000000-0000-4000-8000-0000000000a1',
  stepId: PROVIDER_SENSITIVE_STEP_IDS[0]!,
} as const;
const BLIND_INDEX = 'step-fold-preread-test-user';
const BLOCKED_WITHIN_MS = 10_000;
const TEST_TIMEOUT = 30_000;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
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

describe.skipIf(!url)(
  'carried_* folds beside a peer that changes the row after the writer read it, on Postgres',
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
        emailEncrypted: 'step-fold-preread-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: 'not-real',
        role: 'user',
      });
    });

    beforeEach(async () => {
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
    });

    afterAll(async () => {
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.$client.end({ timeout: 5 });
      await peer.$client.end({ timeout: 5 });
    });

    const seedTask = async (status: TaskStatus) => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId: USER,
          type: 'workflow',
          title: 'step fold pre-read',
          status,
          orchestrationEpoch: 3,
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };

    const seedStep = async (taskId: string, over: StepInsert = {}) => {
      const [row] = await db
        .insert(schema.taskSteps)
        .values({
          id: STEP.id,
          taskId,
          stepId: STEP.stepId,
          stepIndex: 1,
          runSeq: 1,
          title: STEP.stepId,
          status: 'pending',
          idleMs: 4000,
          userActiveMs: 800,
          carriedWorkMs: 1000,
          carriedIdleMs: 200,
          carriedUserActiveMs: 50,
          ...over,
        })
        .returning();
      return row!;
    };

    const finalRow = async () => {
      const [row] = await db
        .select({
          status: schema.taskSteps.status,
          idleMs: schema.taskSteps.idleMs,
          userActiveMs: schema.taskSteps.userActiveMs,
          carriedWorkMs: schema.taskSteps.carriedWorkMs,
          carriedIdleMs: schema.taskSteps.carriedIdleMs,
          carriedUserActiveMs: schema.taskSteps.carriedUserActiveMs,
        })
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.id, STEP.id));
      return row;
    };

    async function besidePeer<T>(codeUnderTest: () => Promise<T>): Promise<T> {
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
              carried_work_ms = carried_work_ms + 7000,
              carried_idle_ms = carried_idle_ms + 3000,
              carried_user_active_ms = carried_user_active_ms + 500,
              idle_ms = idle_ms + 2000
            where id = ${STEP.id}`);
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
      } finally {
        proceed();
        await Promise.all([peerRun, underTest]);
      }

      const [peerOutcome, underTestOutcome] = await Promise.all([peerRun, underTest]);
      if (!peerOutcome.ok) throw peerOutcome.error;
      if (!underTestOutcome.ok) throw underTestOutcome.error;
      return underTestOutcome.value;
    }

    it(
      'F1: resetRowsForRerun folds the row as a peer left it while the reset waited, not the row its caller read',
      async () => {
        const taskId = await seedTask('failed');
        const stale = await seedStep(taskId, {
          status: 'done',
          startedAt: new Date('2026-01-01T00:00:00Z'),
          endedAt: new Date('2026-01-01T00:01:00Z'),
        });

        await besidePeer(() =>
          db.transaction((tx) => resetRowsForRerun(tx, taskId, [stale], new Date())),
        );

        expect(await finalRow()).toEqual({
          status: 'pending',
          idleMs: 0,
          userActiveMs: 0,
          carriedWorkMs: 1000 + 7000 + (60_000 - 6000),
          carriedIdleMs: 200 + 3000 + 6000,
          carriedUserActiveMs: 50 + 500 + 800,
        });
      },
      TEST_TIMEOUT,
    );
  },
);
