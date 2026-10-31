import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.REPO_DELETE_RETRY_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repo_delete_retry_test'))
  throw new Error(
    'Use a dedicated repo_delete_retry_test database for the repository delete Retry tests',
  );

const USER = '00000000-0000-4000-8000-0000000003a1';
const BLIND_INDEX = 'repo-delete-retry-test-user';

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
import { createDatabase, lockRepositoryTasksKey, schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES } from '@haive/shared';
import { repoRoutes } from '../src/routes/repos.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.route('/repos', repoRoutes);
app.onError(errorHandler);

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Answer = { status: number; body: Record<string, unknown> };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];

const FAILED_STEP = '07-implement';
const NEXT_STEP = '08-verify';
const RETRY_WAITS_WITHIN_MS = 10_000;
const DELETE_WAITS_WITHIN_MS = 5_000;

type DeleteWas = 'waiting' | 'ended' | 'timeout';

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeOutcome(outcome: Outcome<Answer>): string {
  return outcome.ok ? `answered ${outcome.value.status}` : `failed: ${String(outcome.error)}`;
}

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

describe.skipIf(!url)('a repository delete beside a Retry of a failed task, on Postgres', () => {
  let db: Database;
  let gate: Database;
  let repositoryId: string;
  let releaseGate: (() => void) | undefined;
  let requests: Promise<unknown>[] = [];

  beforeAll(() => {
    db = createDatabase(url as string);
    gate = createDatabase(url as string);
    h.db = db;
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await gate.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    h.queued = [];
    requests = [];
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'repo-delete-retry-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-a-real-hash',
      role: 'user',
    });
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId: USER, name: 'repo delete retry', source: 'local_path' })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  afterEach(async () => {
    // A test that failed before it let the gate go must not leave its transaction open.
    releaseGate?.();
    releaseGate = undefined;
    await Promise.allSettled(requests);
    await db.delete(schema.repoCleanups).where(eq(schema.repoCleanups.userId, USER));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
  });

  async function seedTask(
    status: TaskStatus,
    steps: { stepId: string; status: StepStatus }[],
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        repositoryId,
        type: 'workflow',
        title: 'retry beside delete',
        status,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;
    const rows = await db
      .insert(schema.taskSteps)
      .values(
        steps.map((step, i) => ({
          taskId,
          stepId: step.stepId,
          stepIndex: i,
          round: 0,
          title: step.stepId,
          status: step.status,
        })),
      )
      .returning({ id: schema.taskSteps.id });
    return { taskId, stepRowIds: rows.map((row) => row.id) };
  }

  /** A task a worker failed on its first step, the shape Retry re-runs at that step. */
  const seedFailedTask = () =>
    seedTask(
      'failed',
      [
        { stepId: FAILED_STEP, status: 'failed' },
        { stepId: NEXT_STEP, status: 'pending' },
      ],
      {
        errorMessage: 'boom',
        completedAt: new Date(),
        currentStepId: FAILED_STEP,
        currentRound: 0,
      },
    );

  const send = (path: string, init: RequestInit) => {
    const run = (async (): Promise<Answer> => {
      const res = await app.request(path, init);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    })();
    requests.push(run);
    const state = { ended: false };
    const done = settle(run);
    void done.then(() => (state.ended = true));
    return { done, state };
  };
  const retry = (taskId: string) =>
    send(`/tasks/${taskId}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
  const deleteRepository = () => send(`/repos/${repositoryId}`, { method: 'DELETE' });

  const taskRow = async (taskId: string) => {
    const [row] = await db
      .select({ status: schema.tasks.status, repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    return row!;
  };
  const stepStatuses = async (taskId: string) =>
    (
      await db
        .select({ status: schema.taskSteps.status })
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(schema.taskSteps.stepIndex)
    ).map((row) => row.status);
  const repositoryExists = async () =>
    (
      await db
        .select({ id: schema.repositories.id })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
    ).length === 1;
  const cancelReasons = async (taskId: string) =>
    (
      await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, 'task.cancelled'),
          ),
        )
    ).map((event) => event.payload?.reason ?? null);
  const cancelJobs = () => h.queued.filter((job) => job.name === TASK_JOB_NAMES.CANCEL);

  /** The gate: its own connection locks one step row for no key update, the lock a Retry's write of
   *  that row waits for, and keeps its transaction open until `release`. */
  async function holdStepRow(stepRowId: string) {
    let release!: () => void;
    const releasing = new Promise<void>((resolve) => (release = resolve));
    let holds!: (pid: number) => void;
    const holding = new Promise<number>((resolve) => (holds = resolve));
    const done = settle(
      gate.transaction(async (tx) => {
        const pid = await backendPid(tx);
        await tx
          .select({ id: schema.taskSteps.id })
          .from(schema.taskSteps)
          .where(eq(schema.taskSteps.id, stepRowId))
          .for('no key update');
        holds(pid);
        await releasing;
      }),
    );
    releaseGate = release;
    const pid = await Promise.race([
      holding,
      done.then(() => {
        throw new Error('the gate transaction ended before it held the step row');
      }),
    ]);
    return { pid, release, done };
  }

  const backendsBlockedBy = async (pid: number): Promise<number[]> =>
    (
      await db.execute<{ pid: number }>(sql`
        select pid from pg_stat_activity
        where wait_event_type = 'Lock' and ${pid}::int = any (pg_blocking_pids(pid))`)
    ).map((row) => row.pid);

  /** The identity of the lock `lockRepositoryTasksKey` takes for the repository, read from pg_locks
   *  while a probe transaction holds it, so the key's text is never restated here. */
  const repositoryKeyOf = (id: string) =>
    db.transaction(async (tx) => {
      await lockRepositoryTasksKey(tx, id);
      const [row] = await tx.execute<{ key: string }>(sql`
        select ((classid::bigint << 32) | objid::bigint)::text as key from pg_locks
        where pid = pg_backend_pid() and locktype = 'advisory' and granted`);
      if (!row) throw new Error('lockRepositoryTasksKey holds no advisory lock in its transaction');
      return row.key;
    });

  const holdsRepositoryKey = async (pid: number, key: string): Promise<boolean> => {
    const [row] = await db.execute<{ held: number }>(sql`
      select count(*)::int as held from pg_locks
      where pid = ${pid}::int and locktype = 'advisory' and granted
        and ((classid::bigint << 32) | objid::bigint) = ${key}::bigint`);
    return row!.held > 0;
  };

  /** Returns the Retry's backend once it waits for the gate while it holds the repository key. */
  async function untilRetryWaitsHoldingTheKey(
    gatePid: number,
    key: string,
    retryEnded: () => boolean,
  ) {
    const deadline = Date.now() + RETRY_WAITS_WITHIN_MS;
    for (;;) {
      if (retryEnded()) throw new Error('the Retry ended before it waited for the gate');
      for (const pid of await backendsBlockedBy(gatePid)) {
        if (await holdsRepositoryKey(pid, key)) return pid;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `no backend waited for the gate while holding the repository key within ${RETRY_WAITS_WITHIN_MS} ms`,
        );
      }
      await pause(20);
    }
  }

  async function untilTheDeleteWaitsOrEnds(
    retryPid: number,
    deleteState: { ended: boolean },
  ): Promise<DeleteWas> {
    const deadline = Date.now() + DELETE_WAITS_WITHIN_MS;
    for (;;) {
      if (deleteState.ended) return 'ended';
      if ((await backendsBlockedBy(retryPid)).length > 0) return 'waiting';
      if (Date.now() > deadline) return 'timeout';
      await pause(20);
    }
  }

  it('makes the delete wait for a Retry that holds the repository key, then cancels the task it revived', async () => {
    const { taskId, stepRowIds } = await seedFailedTask();
    const key = await repositoryKeyOf(repositoryId);
    const held = await holdStepRow(stepRowIds[0]!);
    const retryRun = retry(taskId);
    const retryPid = await untilRetryWaitsHoldingTheKey(held.pid, key, () => retryRun.state.ended);

    const deleteRun = deleteRepository();
    let deleteWas: DeleteWas;
    let retryHeldTheKeyWhenTheDeleteEnded = false;
    try {
      deleteWas = await untilTheDeleteWaitsOrEnds(retryPid, deleteRun.state);
      if (deleteWas === 'ended')
        retryHeldTheKeyWhenTheDeleteEnded = await holdsRepositoryKey(retryPid, key);
    } finally {
      held.release();
      releaseGate = undefined;
    }
    const [retryOutcome, deleteOutcome] = await Promise.all([retryRun.done, deleteRun.done]);
    await held.done;

    const why =
      deleteWas === 'ended'
        ? `the delete ended without waiting for the Retry (${describeOutcome(deleteOutcome)}); at that moment the Retry ${retryHeldTheKeyWhenTheDeleteEnded ? 'still held' : 'no longer held'} the repository key`
        : `the delete neither ended nor waited for the Retry within ${DELETE_WAITS_WITHIN_MS} ms`;
    expect.soft(deleteWas, why).toBe('waiting');
    expect.soft(retryOutcome).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, status: 'running' } },
    });
    expect.soft(deleteOutcome).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, cancelledTasks: 1 } },
    });
    const task = await taskRow(taskId);
    expect
      .soft(
        task.status,
        `the task once both requests ended (repository_id ${task.repositoryId}): running with no repository means the Retry revived it after the delete had cut it loose`,
      )
      .toBe('cancelled');
    expect.soft(await repositoryExists(), 'the repository still exists').toBe(false);
    expect
      .soft(await cancelReasons(taskId), 'task.cancelled events')
      .toEqual(['repository_deleted']);
    expect
      .soft(
        cancelJobs().map((job) => (job.payload as { taskId: string }).taskId),
        'tasks a CANCEL job was queued for',
      )
      .toEqual([taskId]);
  }, 30_000);

  it('cancels the task a Retry revived when the Retry completes before the delete starts', async () => {
    const { taskId } = await seedFailedTask();

    const retried = await retry(taskId).done;
    expect(retried).toMatchObject({
      ok: true,
      value: { status: 200, body: { status: 'running' } },
    });
    expect((await taskRow(taskId)).status).toBe('running');
    const deleted = await deleteRepository().done;

    expect(deleted).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, cancelledTasks: 1 } },
    });
    expect((await taskRow(taskId)).status).toBe('cancelled');
    expect(await repositoryExists()).toBe(false);
    expect(await cancelReasons(taskId)).toEqual(['repository_deleted']);
  }, 30_000);

  it('still deletes a repository and cancels its open task when no Retry is in flight', async () => {
    const { taskId } = await seedTask('running', [
      { stepId: FAILED_STEP, status: 'running' },
      { stepId: NEXT_STEP, status: 'pending' },
    ]);

    const deleted = await deleteRepository().done;

    expect(deleted).toMatchObject({
      ok: true,
      value: { status: 200, body: { ok: true, cancelledTasks: 1 } },
    });
    expect((await taskRow(taskId)).status).toBe('cancelled');
    expect(await stepStatuses(taskId)).toEqual(['failed', 'failed']);
    expect(await repositoryExists()).toBe(false);
    expect(await cancelReasons(taskId)).toEqual(['repository_deleted']);
    expect(cancelJobs().map((job) => (job.payload as { taskId: string }).taskId)).toEqual([taskId]);
  }, 30_000);
});
