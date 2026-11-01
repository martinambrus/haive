import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { closePrPollQueue, runPrPollTick } from '../src/queues/pr-poll-queue.js';
import { processTaskJob, reconcileOrphanedSteps } from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  parkAtAdmission: false,
  /** What the task queue was asked to enqueue. */
  adds: [] as { name: string; data: unknown }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('../src/sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/runtime-admission.js')>()),
  runtimeAdmission: async () => ({
    decision: h.parkAtAdmission ? 'park' : 'proceed',
    busyMb: 3000,
    budgetMb: 4000,
    myWeightMb: 2000,
    position: 1,
    waiting: 1,
  }),
  releaseRuntimeReservation: async () => undefined,
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: unknown) {
      h.adds.push({ name, data });
    }
    async close() {}
  },
}));

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
const RUNTIME_STEP_ID = '03-fold-preread-runtime';
const TYPE = 'fnf461_step_fold_preread';
const BLIND_INDEX = 'worker-step-fold-preread-test-user';
const BLOCKED_WITHIN_MS = 10_000;
const TEST_TIMEOUT = 30_000;

const OTHER_STEP_ID = '03-the-task-moved-here';
const ORPHAN_AGE_MS = 10 * 60_000;
const PR_WAIT_STEP_ID = '13-pr-wait';
const PR_PARKED_FOR_MS = 10 * 60_000;
const INT4_MAX = 2_147_483_647;

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

const stub = (id: string, index: number, needsRuntime?: 'app'): StepDefinition =>
  ({
    ...(needsRuntime ? { needsRuntime } : {}),
    metadata: {
      id,
      workflowType: 'workflow' as WorkflowType,
      index,
      title: id,
      description: 'step fold preread test stub',
      requiresCli: false,
    },
    shouldRun: () => true,
    apply: async () => ({}),
  }) as StepDefinition;

const job = (name: string, data: Record<string, unknown>) =>
  ({
    id: randomUUID(),
    name,
    data,
    timestamp: Date.now(),
    moveToDelayed: async () => undefined,
  }) as unknown as Parameters<typeof processTaskJob>[0];

describe.skipIf(!url)('worker step folds beside a peer that updates the row, on Postgres', () => {
  let db: Database;
  let peer: Database;
  let userId: string;
  let repositoryId: string;

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
    h.db = db;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'step-fold-preread',
        source: 'local_path',
        localPath: os.tmpdir(),
        storagePath: os.tmpdir(),
        status: 'ready',
      })
      .returning({ id: schema.repositories.id });
    repositoryId = repo!.id;
    await db
      .insert(schema.taskTypeDefinitions)
      .values({ slug: TYPE, displayName: TYPE, runListStrategy: 'static', source: 'test' })
      .onConflictDoNothing();
    stepRegistry.override(stub(STEP_ID, 1));
    stepRegistry.override(stub(RUNTIME_STEP_ID, 2, 'app'));
  });

  beforeEach(async () => {
    h.parkAtAdmission = false;
    h.adds.length = 0;
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closePrPollQueue();
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
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

  it(
    'G2: requeueAbandonedOrphan folds the row the peer left, not the row it read before its transaction',
    async () => {
      const startedAt = new Date(Date.now() - ORPHAN_AGE_MS);
      const taskId = await seedTask({ currentStepId: OTHER_STEP_ID, currentRound: 0 });
      const rowId = await seedRow(taskId, { status: 'running', startedAt });

      const before = Date.now();
      await whilePeerHoldsRow(rowId, () =>
        reconcileOrphanedSteps(db, {
          enqueueAdvance: async () => undefined,
          queuedInvocationIds: async () => new Set<string>(),
        }),
      );
      const after = Date.now();

      const row = await rowOf(rowId);
      expect(row).toMatchObject({ status: 'pending', startedAt: null, idleMs: 0, userActiveMs: 0 });
      const carried = carriedOf(row);
      // The run is still open, so its whole span folds into idle and none into work: work is seed 1000 + peer
      // 7000, user is seed 50 + peer 500 + the row's 800. The row read before the peer committed writes 1000 / 850.
      expect(
        { work: carried.work, user: carried.user },
        'carried work and user after the peer and the fold',
      ).toEqual({ work: 8_000, user: 1_350 });
      // seed 200 + peer 3000 + the span from started_at to the fold, which ran between before and after.
      const lowest = 3_200 + (before - startedAt.getTime());
      const highest = 3_200 + (after - startedAt.getTime());
      expect(carried.idle, 'carried idle after the peer and the fold').toBeGreaterThanOrEqual(
        lowest,
      );
      expect(carried.idle, 'carried idle after the peer and the fold').toBeLessThanOrEqual(highest);
    },
    TEST_TIMEOUT,
  );

  /** A task parked on `stepId` by an advance at the epoch the task is at, holding the one pending row seeded. */
  const advanceOnPendingRow = async (
    stepId: string,
    taskOver: Partial<typeof schema.tasks.$inferInsert>,
  ) => {
    const taskId = await seedTask({
      repositoryId,
      type: TYPE,
      currentStepId: stepId,
      currentRound: 0,
      runListSnapshot: [stepId],
      ...taskOver,
    });
    const rowId = await seedRow(taskId, { stepId, status: 'pending' });
    const advance = () =>
      processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId, round: 0, epoch: 3 }),
      );
    return { rowId, advance };
  };

  it(
    'G3: the pause park folds the row the peer left, not the row it read before its transaction',
    async () => {
      const { rowId, advance } = await advanceOnPendingRow(STEP_ID, { pausedAt: new Date() });

      await whilePeerHoldsRow(rowId, advance);

      const row = await rowOf(rowId);
      expect(row).toMatchObject({ status: 'pending', startedAt: null, idleMs: 0, userActiveMs: 0 });
      expect(row.waitingStartedAt).toBeInstanceOf(Date);
      expect(row.statusMessage).toMatch(/^Paused/);
      // A pending row with no run folds only its live idle and user, which the peer left at 6000 and 800: seed
      // 1000/200/50 + peer 7000/3000/500 + fold 0/6000/800. The row read before the peer committed writes 1000/4200/850.
      expect(carriedOf(row), 'carried_* after the peer and the fold').toEqual({
        work: 8_000,
        idle: 9_200,
        user: 1_350,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'G4: the runtime-admission park folds the row the peer left, not the row it read before its transaction',
    async () => {
      h.parkAtAdmission = true;
      const { rowId, advance } = await advanceOnPendingRow(RUNTIME_STEP_ID, {});

      await whilePeerHoldsRow(rowId, advance);

      const row = await rowOf(rowId);
      expect(row).toMatchObject({ status: 'pending', startedAt: null, idleMs: 0, userActiveMs: 0 });
      expect(row.waitingStartedAt).toBeInstanceOf(Date);
      expect(row.statusMessage).toMatch(/^Waiting for a free runtime slot/);
      // The same row and the same fold as G3.
      expect(carriedOf(row), 'carried_* after the peer and the fold').toEqual({
        work: 8_000,
        idle: 9_200,
        user: 1_350,
      });
    },
    TEST_TIMEOUT,
  );

  /** A merged pull request whose task waits on `13-pr-wait`, the form the poller answers with `{}`; null
   *  `parkedForMs` is a form whose wait is already closed. */
  const seedParkedPrWait = async (parkedForMs: number | null, over: StepInsert = {}) => {
    const taskId = await seedTask({
      status: 'waiting_pr',
      prProvider: 'github',
      prNumber: '7',
      prUrl: 'https://github.com/acme/app/pull/7',
      prState: 'merged',
      prFinalizeMode: 'auto',
    });
    const parkedAt = parkedForMs === null ? null : new Date(Date.now() - parkedForMs);
    const rowId = await seedRow(taskId, {
      stepId: PR_WAIT_STEP_ID,
      status: 'waiting_form',
      waitingStartedAt: parkedAt,
      ...over,
    });
    return { taskId, rowId, parkedAt };
  };

  const advanceJobs = () => h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);

  it(
    'G5: the PR poller adds the wait to the idle_ms the peer left, not to the one it read before its update',
    async () => {
      vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
      const { taskId, rowId, parkedAt } = await seedParkedPrWait(PR_PARKED_FOR_MS);

      let before = 0;
      await whilePeerHoldsRow(rowId, () => {
        before = Date.now();
        return runPrPollTick(db);
      });
      const after = Date.now();

      const row = await rowOf(rowId);
      expect(row).toMatchObject({ status: 'waiting_form', formValues: {}, waitingStartedAt: null });
      // seed 4000 + the peer's 2000 + the wait up to the update. The idle_ms read before the peer committed
      // writes 4000 plus the wait.
      const seeded = SEED.liveIdle + PEER.liveIdle;
      expect(row.idleMs, 'idle_ms after the peer and the wait').toBeGreaterThanOrEqual(
        seeded + (before - parkedAt!.getTime()),
      );
      expect(row.idleMs, 'idle_ms after the peer and the wait').toBeLessThanOrEqual(
        seeded + (after - parkedAt!.getTime()),
      );
      expect(advanceJobs()).toEqual([
        {
          name: TASK_JOB_NAMES.ADVANCE_STEP,
          data: { taskId, userId, stepId: PR_WAIT_STEP_ID, round: 0, formValues: {} },
        },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'G6: the PR poller keeps the idle time within its integer column',
    async () => {
      vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
      const { rowId } = await seedParkedPrWait(PR_PARKED_FOR_MS, { idleMs: INT4_MAX - 1_000 });

      await runPrPollTick(db);

      expect(await rowOf(rowId)).toMatchObject({
        idleMs: INT4_MAX,
        formValues: {},
        waitingStartedAt: null,
      });
      expect(advanceJobs()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'G7: the PR poller adds nothing to the idle time on a re-drive, once the wait is closed',
    async () => {
      vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
      const { rowId } = await seedParkedPrWait(null);

      await runPrPollTick(db);

      expect(await rowOf(rowId)).toMatchObject({
        idleMs: SEED.liveIdle,
        formValues: {},
        waitingStartedAt: null,
      });
      expect(advanceJobs()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});
