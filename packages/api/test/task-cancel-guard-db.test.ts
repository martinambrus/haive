import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TASK_CANCEL_GUARD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_cancel_guard_test'))
  throw new Error(
    'Use a dedicated task_cancel_guard_test database for the task cancel guard tests',
  );

const USER = '00000000-0000-4000-8000-0000000003b1';
const BLIND_INDEX = 'task-cancel-guard-test-user';

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
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES } from '@haive/shared';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Answer = { status: number; body: Record<string, unknown> };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];

const STEP = '07-implement';
const BLOCKED_WITHIN_MS = 10_000;

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

describe.skipIf(!url)('a task cancel or step abort beside another writer, on Postgres', () => {
  let db: Database;
  let racer: Database;
  let repositoryId: string;
  let proceed: (() => void) | undefined;
  let requests: Promise<unknown>[] = [];

  beforeAll(() => {
    db = createDatabase(url as string);
    racer = createDatabase(url as string);
    h.db = db;
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await racer.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    h.queued = [];
    requests = [];
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'task-cancel-guard-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-a-real-hash',
      role: 'user',
    });
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId: USER, name: 'task cancel guard', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  afterEach(async () => {
    // A test that failed before it let the racer go must not leave its transaction open.
    proceed?.();
    proceed = undefined;
    await Promise.allSettled(requests);
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
  });

  async function seedTask(
    status: TaskStatus,
    steps: StepStatus[],
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        repositoryId,
        type: 'workflow',
        title: 'cancel guard',
        status,
        currentStepId: STEP,
        currentRound: 0,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;
    const rows = await db
      .insert(schema.taskSteps)
      .values(
        steps.map((stepStatus, i) => ({
          taskId,
          stepId: i === 0 ? STEP : `${STEP}-${i}`,
          stepIndex: i,
          round: 0,
          title: `step ${i}`,
          status: stepStatus,
        })),
      )
      .returning({ id: schema.taskSteps.id });
    return { taskId, stepRowIds: rows.map((row) => row.id) };
  }

  const send = (path: string, body: Record<string, unknown>) => {
    const run = (async (): Promise<Answer> => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    })();
    requests.push(run);
    const state = { ended: false };
    const done = settle(run);
    void done.then(() => (state.ended = true));
    return { done, state };
  };
  const cancel = (taskId: string) => send(`/tasks/${taskId}/action`, { action: 'cancel' });
  const abort = (taskId: string, stepId: string) =>
    send(`/tasks/${taskId}/steps/${stepId}/action`, { action: 'abort' });

  const taskStatus = async (taskId: string) => {
    const [row] = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    return row!.status;
  };
  const stepsOf = (taskId: string) =>
    db
      .select({
        status: schema.taskSteps.status,
        errorMessage: schema.taskSteps.errorMessage,
        endedAt: schema.taskSteps.endedAt,
      })
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(schema.taskSteps.stepIndex);
  const cancelEvents = (taskId: string) =>
    db
      .select({ payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, taskId),
          eq(schema.taskEvents.eventType, 'task.cancelled'),
        ),
      );
  const cancelJobs = () => h.queued.filter((job) => job.name === TASK_JOB_NAMES.CANCEL);
  /** One `task.cancelled` event by the caller and one CANCEL job for the task. */
  const expectOneCancel = async (taskId: string) => {
    const events = await cancelEvents(taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ by: USER });
    expect(cancelJobs().map((job) => job.payload)).toMatchObject([{ taskId, userId: USER }]);
  };

  /** The racer holds the running step row it just ended, the request's first write that reaches it
   *  waits, and `second` is what the racer then writes to the task before it commits. */
  async function raceRequest(
    what: 'cancel' | 'abort',
    start: () => ReturnType<typeof send>,
    stepRowId: string,
    second: (tx: Tx) => PromiseLike<unknown>,
  ) {
    let racerHolds!: (pid: number) => void;
    const holding = new Promise<number>((resolve) => (racerHolds = resolve));
    const proceeding = new Promise<void>((resolve) => (proceed = resolve));
    const racerRun = settle(
      racer.transaction(async (tx) => {
        const pid = await backendPid(tx);
        await tx
          .update(schema.taskSteps)
          .set({ status: 'done', endedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.taskSteps.id, stepRowId));
        racerHolds(pid);
        await proceeding;
        await second(tx);
      }),
    );
    const racerPid = await Promise.race([
      holding,
      racerRun.then(() => {
        throw new Error('the racer ended before it held the step row');
      }),
    ]);

    const request = start();
    try {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      for (;;) {
        if (request.state.ended) throw new Error(`the ${what} ended without waiting for the racer`);
        const [row] = await db.execute<{ blocked: number }>(sql`
          select count(*)::int as blocked from pg_stat_activity
          where wait_event_type = 'Lock' and ${racerPid}::int = any (pg_blocking_pids(pid))`);
        if (row!.blocked > 0) break;
        if (Date.now() > deadline) {
          throw new Error(
            `the ${what} was not blocked by the racer within ${BLOCKED_WITHIN_MS} ms`,
          );
        }
        await pause(20);
      }
    } finally {
      proceed?.();
      proceed = undefined;
    }

    const [racerOutcome, answer] = await Promise.all([racerRun, request.done]);
    expect.soft(racerOutcome.ok ? null : describeError(racerOutcome.error), 'racer').toBeNull();
    return answer;
  }

  const completeTask = (taskId: string) => (tx: Tx) =>
    tx
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));

  it('leaves a task that completed while the cancel waited completed, with no event and no job', async () => {
    const { taskId, stepRowIds } = await seedTask('running', ['running']);

    const answer = await raceRequest(
      'cancel',
      () => cancel(taskId),
      stepRowIds[0]!,
      completeTask(taskId),
    );

    expect.soft(answer).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'completed' } },
    });
    expect.soft(await taskStatus(taskId), 'task status after the cancel').toBe('completed');
    expect.soft(await cancelEvents(taskId), 'task.cancelled events').toEqual([]);
    expect.soft(cancelJobs(), 'CANCEL jobs queued').toEqual([]);
  }, 30_000);

  it('writes no second cancel event and queues no job for a task cancelled while the cancel waited', async () => {
    const { taskId, stepRowIds } = await seedTask('running', ['running']);

    const answer = await raceRequest(
      'cancel',
      () => cancel(taskId),
      stepRowIds[0]!,
      async (tx) => {
        await tx
          .update(schema.tasks)
          .set({ status: 'cancelled', completedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.tasks.id, taskId));
        await tx
          .insert(schema.taskEvents)
          .values({ taskId, eventType: 'task.cancelled', payload: { by: USER } });
      },
    );

    expect.soft(answer).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'cancelled' } },
    });
    expect.soft(await taskStatus(taskId), 'task status after the cancel').toBe('cancelled');
    expect.soft(await cancelEvents(taskId), 'task.cancelled events').toHaveLength(1);
    expect.soft(cancelJobs(), 'CANCEL jobs queued').toEqual([]);
  }, 30_000);

  it('cancels a failed task', async () => {
    const { taskId } = await seedTask('failed', ['failed'], {
      errorMessage: 'boom',
      completedAt: new Date(),
    });

    const answer = await cancel(taskId).done;

    expect(answer).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'cancelled' } },
    });
    expect(await taskStatus(taskId)).toBe('cancelled');
    expect((await stepsOf(taskId)).map((step) => step.status)).toEqual(['failed']);
    await expectOneCancel(taskId);
  }, 30_000);

  it('cancels a running task and ends its open steps', async () => {
    const { taskId } = await seedTask('running', ['running', 'pending']);

    const answer = await cancel(taskId).done;

    expect(answer).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'cancelled' } },
    });
    expect(await taskStatus(taskId)).toBe('cancelled');
    const ended = await stepsOf(taskId);
    expect(ended.map((step) => step.status)).toEqual(['failed', 'failed']);
    expect(ended.map((step) => step.endedAt !== null)).toEqual([true, true]);
    // The running step is failed by the stop that runs first, with its own text; only a row the
    // cancel itself ends carries "Task cancelled".
    expect(ended[1]!.errorMessage).toBe('Task cancelled');
    await expectOneCancel(taskId);
  }, 30_000);

  it('leaves a task that completed while a step abort waited completed, with no event and no job', async () => {
    // The abort has no stop phase, so its own locking is what waits for the racer: taking the task
    // row before the step rows deadlocks with the racer's task write. On the unchanged code the abort
    // writes the task row before it reaches the step row it waits for, so the racer's completion
    // lands last and only the answer, the event and the job are wrong.
    const { taskId, stepRowIds } = await seedTask('running', ['running', 'pending']);

    const answer = await raceRequest(
      'abort',
      () => abort(taskId, STEP),
      stepRowIds[0]!,
      completeTask(taskId),
    );

    expect.soft(answer).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'completed' } },
    });
    expect.soft(await taskStatus(taskId), 'task status after the abort').toBe('completed');
    expect.soft(await cancelEvents(taskId), 'task.cancelled events').toEqual([]);
    expect.soft(cancelJobs(), 'CANCEL jobs queued').toEqual([]);
  }, 30_000);

  it('cancels the failed task a step abort is sent for', async () => {
    const { taskId } = await seedTask('failed', ['failed'], {
      errorMessage: 'boom',
      completedAt: new Date(),
    });

    const answer = await abort(taskId, STEP).done;

    expect(answer).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'cancelled' } },
    });
    expect(await taskStatus(taskId)).toBe('cancelled');
    expect((await stepsOf(taskId)).map((step) => step.status)).toEqual(['failed']);
    await expectOneCancel(taskId);
  }, 30_000);
});
