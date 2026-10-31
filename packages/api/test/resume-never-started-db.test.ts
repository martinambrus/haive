import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.RESUME_NEVER_STARTED_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/resume_never_started_test'))
  throw new Error(
    'Use a dedicated resume_never_started_test database for the never-started resume tests',
  );

const USER = '00000000-0000-4000-8000-0000000000f5';
const BLIND_INDEX = 'resume-never-started-test-user';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
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
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INT4_MAX = 2_147_483_647;
/** The clock gap between a seed and the statement that reads now(), far below any bug's size. */
const SLACK = MINUTE;
/** A loop step: the loop Resume arm needs one, and retry_ai takes any failed row. */
const STEP = '07b-phase-4-validate';
const CLOSED_FOR = 30 * MINUTE;
const IDLE_BEFORE = 5000;
const CARRIED_BEFORE = 7;

const ago = (ms: number) => new Date(Date.now() - ms);

const expectAbout = (what: string, actual: number, expected: number) => {
  expect(actual, `${what} is about ${expected}`).toBeGreaterThan(expected - SLACK);
  expect(actual, `${what} is about ${expected}`).toBeLessThan(expected + SLACK);
};

describe.skipIf(!url)('re-opening a failed step that never started, on Postgres', () => {
  let db: Database;
  /** Runs once inside the next `transaction` call, before it starts: the moment after the route
   *  has read the row and before it writes. */
  let beforeTransaction: (() => Promise<void>) | undefined;

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const act = async (taskId: string, action: 'resume' | 'retry_ai') => {
    const res = await post(`/tasks/${taskId}/steps/${STEP}/action`, { action, round: 0 });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };
  const stop = async (taskId: string) => {
    const res = await post(`/tasks/${taskId}/cancel-active-cli`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };

  const seedTask = async (status: (typeof schema.tasks.$inferInsert)['status']) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'resume-never-started',
        status,
        currentStepId: STEP,
        currentRound: 0,
        orchestrationEpoch: 3,
      })
      .returning();
    return row!;
  };
  const seedRow = async (
    taskId: string,
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: STEP,
        stepIndex: 7.5,
        runSeq: 3,
        round: 0,
        title: 'Validate',
        status: 'failed',
        errorMessage: 'Stopped by user',
        startedAt: null,
        endedAt: ago(CLOSED_FOR),
        idleMs: IDLE_BEFORE,
        carriedIdleMs: CARRIED_BEFORE,
        ...over,
      })
      .returning();
    return row!;
  };
  const rowOf = async (id: string) =>
    (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
  const taskOf = async (id: string) =>
    (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = Object.create(db, {
      transaction: {
        value: async (...args: Parameters<Database['transaction']>) => {
          const hook = beforeTransaction;
          beforeTransaction = undefined;
          await hook?.();
          return db.transaction(...args);
        },
      },
    });
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'resume-never-started-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
  });

  beforeEach(async () => {
    h.queued = [];
    beforeTransaction = undefined;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe.each([
    { arm: 'the loop Resume', action: 'resume' as const },
    { arm: 'retry_ai', action: 'retry_ai' as const },
  ])('$arm', ({ action }) => {
    it('starts a failed row that never started: started_at stamped, idle_ms moved with the closed gap into carried_idle_ms', async () => {
      const task = await seedTask('failed');
      const row = await seedRow(task.id);

      await act(task.id, action);

      const after = await rowOf(row.id);
      expect(after.status).toBe('running');
      expect(after.endedAt).toBeNull();
      expect(after.errorMessage).toBeNull();
      expect(after.startedAt).not.toBeNull();
      expectAbout('started_at', after.startedAt!.getTime(), Date.now());
      expect(after.idleMs).toBe(0);
      expectAbout(
        'carried_idle_ms',
        after.carriedIdleMs,
        CARRIED_BEFORE + IDLE_BEFORE + CLOSED_FOR,
      );
      expect((await taskOf(task.id)).status).toBe('running');
      expect(h.queued).toMatchObject([
        { name: TASK_JOB_NAMES.ADVANCE_STEP, payload: { stepId: STEP, round: 0, epoch: 4 } },
      ]);
    });

    it('keeps a failed row that had started as it is: started_at kept, the closed gap in idle_ms, carried_idle_ms untouched (pin)', async () => {
      const startedAt = ago(2 * HOUR);
      const task = await seedTask('failed');
      const row = await seedRow(task.id, { startedAt });

      await act(task.id, action);

      const after = await rowOf(row.id);
      expect(after.status).toBe('running');
      expect(after.endedAt).toBeNull();
      expect(after.startedAt?.getTime()).toBe(startedAt.getTime());
      expectAbout('idle_ms', after.idleMs, IDLE_BEFORE + CLOSED_FOR);
      expect(after.carriedIdleMs).toBe(CARRIED_BEFORE);
    });

    it('fills carried_idle_ms to 2147483647 for a closed gap past the int4 range instead of raising', async () => {
      const task = await seedTask('failed');
      const row = await seedRow(task.id, { endedAt: ago(40 * DAY), carriedIdleMs: 0 });

      await act(task.id, action);

      const after = await rowOf(row.id);
      expect(after.status).toBe('running');
      expect(after.startedAt).not.toBeNull();
      expect(after.idleMs).toBe(0);
      expect(after.carriedIdleMs).toBe(INT4_MAX);
    });

    it('fills a nearly full carried_idle_ms to 2147483647 instead of raising', async () => {
      const task = await seedTask('failed');
      const row = await seedRow(task.id, { carriedIdleMs: INT4_MAX - 1000 });

      await act(task.id, action);

      const after = await rowOf(row.id);
      expect(after.status).toBe('running');
      expect(after.startedAt).not.toBeNull();
      expect(after.idleMs).toBe(0);
      expect(after.carriedIdleMs).toBe(INT4_MAX);
    });

    it('decides never-started in SQL on the row it locks: a row started after the route read it keeps its started_at and bills the gap to idle_ms (pin)', async () => {
      const startedMeanwhile = ago(HOUR);
      const task = await seedTask('failed');
      const row = await seedRow(task.id);
      beforeTransaction = async () => {
        await db
          .update(schema.taskSteps)
          .set({ startedAt: startedMeanwhile })
          .where(eq(schema.taskSteps.id, row.id));
      };

      await act(task.id, action);

      const after = await rowOf(row.id);
      expect(after.status).toBe('running');
      expect(after.startedAt?.getTime()).toBe(startedMeanwhile.getTime());
      expectAbout('idle_ms', after.idleMs, IDLE_BEFORE + CLOSED_FOR);
      expect(after.carriedIdleMs).toBe(CARRIED_BEFORE);
    });

    it('ends running with started_at set and the park in carried_idle_ms when a pre-run park is failed by a real Stop first', async () => {
      const parkedFor = 10 * MINUTE;
      const task = await seedTask('running');
      const row = await seedRow(task.id, {
        status: 'pending',
        errorMessage: null,
        endedAt: null,
        idleMs: 0,
        waitingStartedAt: ago(parkedFor),
      });
      await stop(task.id);
      expect((await rowOf(row.id)).status).toBe('failed');
      expect((await taskOf(task.id)).status).toBe('failed');

      await act(task.id, action);

      const after = await rowOf(row.id);
      expect(after.status).toBe('running');
      expect(after.startedAt).not.toBeNull();
      expect(after.idleMs).toBe(0);
      expect(after.waitingStartedAt).toBeNull();
      expectAbout('carried_idle_ms', after.carriedIdleMs, CARRIED_BEFORE + parkedFor);
      expect((await taskOf(task.id)).status).toBe('running');
    });
  });
});
