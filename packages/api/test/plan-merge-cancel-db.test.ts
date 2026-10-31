import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.PLAN_MERGE_CANCEL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_merge_cancel_test'))
  throw new Error(
    'Use a dedicated plan_merge_cancel_test database for the plan merge cancel tests',
  );

const USER = '00000000-0000-4000-8000-0000000004c1';
const BLIND_INDEX = 'plan-merge-cancel-test-user';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  queued: [] as { name: string; payload: unknown }[],
  killed: [] as string[],
  thrown: undefined as unknown,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string, payload: unknown) => {
      h.queued.push({ name, payload });
    },
  });
  return { getTaskQueue: queue, getRepoQueue: queue };
});
vi.mock('../src/lib/sandbox-kill.js', () => ({
  killTaskSandboxes: async (taskId: string) => {
    h.killed.push(taskId);
    return 0;
  },
}));
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
      get: async (key: string) => (key === shared.CONFIG_KEYS.PLAN_CANVAS_ENABLED ? 'true' : null),
      getBoolean: async () => false,
      getFresh: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? 'normal' : null,
      set: async () => undefined,
    },
  };
});

import { Hono } from 'hono';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';
import { TASK_JOB_NAMES } from '@haive/shared';
import { planRoutes } from '../src/routes/plan.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/repositories', planRoutes);
// Not the real errorHandler: it answers a 40P01 with a bare 500 and hides which error ended the route.
app.onError((err, c) => {
  h.thrown = err;
  return c.json({ error: 'the route threw' }, 500);
});

// DELETE /repositories/:id/plan/merge abandons the repository's open merge conversation (a
// plan_merge task that is created, queued, running, paused or waiting for the user). It takes the
// Cancel action's steps: it stops the task's live CLI runs, then decides under the task's locks
// (cancelTaskIfOpen: a task that completed or was cancelled meanwhile is left as it is), ends the
// task's pause and queues the CANCEL job only when that cancel applied (P7, P8). A merge that is
// already completed, cancelled or failed is no open conversation: the DELETE answers
// cancelled:false and writes nothing (P5).
// P1 and P6 hold a step row in a second connection and observe the DELETE blocked on it, so they
// also pin the order the DELETE takes its locks in: the task's step rows in id order, holding none
// while it waits, before the task row.
//
// P6 seeds two `pending` open rows, A (lower id) and B (higher id), inserted B then A, with step ids
// that make every scan order (physical, task_id index, the unique task/step/round index) reach B
// first. The peer locks A and waits until the DELETE is blocked on it, then locks B and commits. A
// DELETE that takes its rows in id order waits for A holding nothing, so both finish.
const STEP = '01-plan-merge';
const A = { id: '00000000-0000-4000-8000-0000000004a1', stepId: 'step-b' } as const;
const B = { id: '00000000-0000-4000-8000-0000000004b1', stepId: 'step-a' } as const;
const NAMES: Record<string, string> = { [A.id]: 'A', [B.id]: 'B' };
const BLOCKED_WITHIN_MS = 10_000;
const SEED_ATTEMPTS = 10;
const TEST_TIMEOUT = 30_000;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Lock = (tx: Tx) => PromiseLike<unknown>;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Answer = { status: number; body: Record<string, unknown> };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];
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

/** The pass finishes the step: the update takes and keeps the row until the peer commits. */
const endStepRow =
  (id: string): Lock =>
  (tx) =>
    tx
      .update(schema.taskSteps)
      .set({ status: 'done', endedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.taskSteps.id, id));

const completeTask =
  (id: string): Lock =>
  (tx) =>
    tx
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.tasks.id, id));

describe.skipIf(!url)('DELETE /plan/merge beside a completion and a peer, on Postgres', () => {
  let db: Database;
  let peer: Database;
  let repositoryId: string;

  beforeAll(() => {
    db = createDatabase(url as string);
    peer = createDatabase(url as string);
    h.db = db;
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await peer.$client.end({ timeout: 5 });
  });

  const seedRepository = async (name: string) => {
    const [repository] = await db
      .insert(schema.repositories)
      .values({ userId: USER, name, source: 'local_path' })
      .returning({ id: schema.repositories.id });
    return repository!.id;
  };

  beforeEach(async () => {
    h.queued = [];
    h.killed = [];
    h.thrown = undefined;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'plan-merge-cancel-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-a-real-hash',
      role: 'user',
    });
    repositoryId = await seedRepository('plan merge cancel');
  });

  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
  });

  /** A `plan_merge` task of the repository unless `over` says otherwise, one step row per status. */
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
        type: 'plan_merge',
        title: 'plan merge',
        status,
        currentStepId: STEP,
        currentRound: 0,
        orchestrationEpoch: 3,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;
    if (steps.length === 0) return { taskId, stepRowIds: [] as string[] };
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

  /** A CLI run of the step that nobody has ended. */
  const seedLiveRun = (taskId: string, taskStepId: string) =>
    db.insert(schema.cliInvocations).values({ taskId, taskStepId, mode: 'cli', prompt: 'work' });

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

  const removeMerge = async (taskId?: string): Promise<Answer> => {
    h.thrown = undefined;
    const res = await app.request(
      `/repositories/${repositoryId}/plan/merge${taskId === undefined ? '' : `?taskId=${encodeURIComponent(taskId)}`}`,
      {
        method: 'DELETE',
      },
    );
    if (h.thrown !== undefined) throw h.thrown;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const taskOf = async (id: string) =>
    (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, id) }))!;
  const rowOf = async (id: string) =>
    (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
  const stepsOf = (taskId: string) =>
    db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(schema.taskSteps.stepIndex);
  const runsOf = (taskId: string) =>
    db
      .select()
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.taskId, taskId))
      .orderBy(schema.cliInvocations.id);
  const eventsOf = (taskId: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, taskId))
      .orderBy(schema.taskEvents.id);
  const cancelEvents = async (taskId: string) =>
    (await eventsOf(taskId)).filter((event) => event.eventType === 'task.cancelled');
  const cancelJobs = () => h.queued.filter((job) => job.name === TASK_JOB_NAMES.CANCEL);

  /** Everything the DELETE could write for a task, to be compared before and after. */
  const snapshot = async (taskId: string) => ({
    task: await taskOf(taskId),
    steps: await stepsOf(taskId),
    runs: await runsOf(taskId),
    events: await eventsOf(taskId),
  });

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
    'P1: leaves a merge that completed while the DELETE waited completed, with no event and no job',
    async () => {
      const { taskId, stepRowIds } = await seedTask('running', ['running']);

      const run = await interleave(
        removeMerge,
        { first: endStepRow(stepRowIds[0]!), second: completeTask(taskId) },
        [],
      );

      expectClean(run);
      expect.soft(run.result, 'the answer').toEqual({
        status: 200,
        body: { ok: true, cancelled: false },
      });
      expect.soft((await taskOf(taskId)).status, 'task status after the DELETE').toBe('completed');
      expect.soft((await rowOf(stepRowIds[0]!)).status, 'the step the pass ended').toBe('done');
      expect.soft(await cancelEvents(taskId), 'task.cancelled events').toEqual([]);
      expect.soft(cancelJobs(), 'CANCEL jobs queued').toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'P2: cancels an open merge as the Cancel action does: the running step is stopped, the rest ended, one event, one job',
    async () => {
      const { taskId } = await seedTask('running', ['running', 'pending']);

      const answer = await removeMerge();

      expect.soft(answer, 'the answer').toEqual({
        status: 200,
        body: { ok: true, cancelled: true, taskId },
      });
      const task = await taskOf(taskId);
      expect.soft(task.status, 'task status after the DELETE').toBe('cancelled');
      expect.soft(task.orchestrationEpoch, 'epoch, bumped so queued advances are dropped').toBe(4);
      expect.soft(task.completedAt, 'task exit time').toBeInstanceOf(Date);
      const steps = await stepsOf(taskId);
      expect.soft(steps.map((step) => step.status)).toEqual(['failed', 'failed']);
      // The running step is failed by the stop that runs first, with its own text; only a row the
      // cancel itself ends carries "Task cancelled".
      expect
        .soft(steps.map((step) => step.errorMessage))
        .toEqual(['Stopped by user', 'Task cancelled']);
      expect.soft(steps.map((step) => step.endedAt !== null)).toEqual([true, true]);
      const events = await cancelEvents(taskId);
      expect.soft(events, 'task.cancelled events').toHaveLength(1);
      expect.soft(events[0]?.payload, 'who cancelled').toMatchObject({ by: USER });
      expect
        .soft(
          cancelJobs().map((job) => job.payload),
          'CANCEL jobs queued',
        )
        .toMatchObject([{ taskId, userId: USER }]);
    },
    TEST_TIMEOUT,
  );

  it(
    'P3: stops the live CLI run of the merge and kills the task sandboxes',
    async () => {
      const { taskId, stepRowIds } = await seedTask('running', ['running']);
      await seedLiveRun(taskId, stepRowIds[0]!);

      const answer = await removeMerge();

      expect.soft(answer, 'the answer').toEqual({
        status: 200,
        body: { ok: true, cancelled: true, taskId },
      });
      const [run] = await runsOf(taskId);
      expect.soft(run?.exitCode, 'run exit code').toBe(137);
      expect.soft(run?.endedAt, 'run ended_at').toBeInstanceOf(Date);
      expect.soft(run?.supersededAt, 'run superseded_at').toBeInstanceOf(Date);
      expect.soft(h.killed, 'tasks whose sandboxes were killed').toContain(taskId);
    },
    TEST_TIMEOUT,
  );

  it(
    'P4: answers cancelled:false and touches nothing when the repository has no merge task',
    async () => {
      // Open tasks that are not this repository's merge conversation must stay as they are.
      const otherRepositoryId = await seedRepository('another repository');
      const sameRepositoryWorkflow = await seedTask('running', ['running'], { type: 'workflow' });
      const otherRepositoryMerge = await seedTask('running', ['running'], {
        repositoryId: otherRepositoryId,
      });
      const before = [
        await snapshot(sameRepositoryWorkflow.taskId),
        await snapshot(otherRepositoryMerge.taskId),
      ];

      const answer = await removeMerge();

      expect
        .soft(answer, 'the answer')
        .toEqual({ status: 200, body: { ok: true, cancelled: false } });
      expect
        .soft(
          [
            await snapshot(sameRepositoryWorkflow.taskId),
            await snapshot(otherRepositoryMerge.taskId),
          ],
          'the open tasks that are not this repository merge, with their steps, runs and events',
        )
        .toEqual(before);
      expect.soft(h.queued, 'jobs queued').toEqual([]);
      expect.soft(h.killed, 'tasks whose sandboxes were killed').toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it.each(['completed', 'cancelled', 'failed'] as const)(
    'P5: answers cancelled:false and changes nothing for the only merge task, already %s',
    async (status) => {
      const { taskId } = await seedTask(status, [status === 'completed' ? 'done' : 'failed'], {
        completedAt: new Date(),
      });
      if (status === 'cancelled') {
        await db
          .insert(schema.taskEvents)
          .values({ taskId, eventType: 'task.cancelled', payload: { by: USER } });
      }
      const before = await snapshot(taskId);

      const answer = await removeMerge();

      expect
        .soft(answer, 'the answer')
        .toEqual({ status: 200, body: { ok: true, cancelled: false } });
      expect
        .soft(await snapshot(taskId), 'the merge task with its steps, runs and events')
        .toEqual(before);
      expect.soft(h.queued, 'jobs queued').toEqual([]);
      expect.soft(h.killed, 'tasks whose sandboxes were killed').toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it('P9: a stale displayed task cannot stop or cancel a newer merge', async () => {
    const old = await seedTask('completed', ['done'], { completedAt: new Date() });
    const current = await seedTask('running', ['running'], { pausedAt: new Date() });
    await seedLiveRun(current.taskId, current.stepRowIds[0]!);
    const before = await snapshot(current.taskId);

    expect(await removeMerge(old.taskId)).toEqual({
      status: 200,
      body: { ok: true, cancelled: false },
    });
    expect(await snapshot(current.taskId)).toEqual(before);
    expect(h.queued).toEqual([]);
    expect(h.killed).toEqual([]);
  });

  it('P10: an explicitly named open merge is stopped then cancelled as before', async () => {
    const { taskId, stepRowIds } = await seedTask('running', ['running'], { pausedAt: new Date() });
    await seedLiveRun(taskId, stepRowIds[0]!);

    expect(await removeMerge(taskId)).toEqual({
      status: 200,
      body: { ok: true, cancelled: true, taskId },
    });
    expect((await taskOf(taskId)).status).toBe('cancelled');
    expect((await taskOf(taskId)).pausedAt).toBeNull();
    expect((await rowOf(stepRowIds[0]!)).errorMessage).toBe('Stopped by user');
    expect((await runsOf(taskId))[0]?.exitCode).toBe(137);
    expect(h.killed).toEqual([taskId]);
    expect(cancelJobs()).toHaveLength(1);
  });

  it(
    'P6: over two pending open rows B and A, waits for A without holding B and cancels the merge',
    async () => {
      const { taskId } = await seedTask('running', []);
      await seedSteps(taskId, { status: 'pending' }, { status: 'pending' });

      const run = await interleave(removeMerge, idOrderedPeer, [B.id]);

      expectClean(run);
      expect(run.result).toEqual({ status: 200, body: { ok: true, cancelled: true, taskId } });
      expect((await taskOf(taskId)).status).toBe('cancelled');
      expect(await rowOf(B.id)).toMatchObject({ status: 'failed', errorMessage: 'Task cancelled' });
      expect(await rowOf(A.id)).toMatchObject({ status: 'failed', errorMessage: 'Task cancelled' });
    },
    TEST_TIMEOUT,
  );

  it(
    'P7: ends the pause of a paused merge the DELETE cancels, as the Cancel action does',
    async () => {
      // The step-retry endpoint has no status guard, so a cancelled task is still resumable, and a
      // stale paused_at would park it again the moment someone revived it.
      const { taskId } = await seedTask('running', ['running', 'pending'], {
        pausedAt: new Date(),
      });

      const answer = await removeMerge();

      expect.soft(answer, 'the answer').toEqual({
        status: 200,
        body: { ok: true, cancelled: true, taskId },
      });
      const task = await taskOf(taskId);
      expect.soft(task.status, 'task status after the DELETE').toBe('cancelled');
      expect.soft(task.pausedAt, 'paused_at after the DELETE').toBeNull();
      expect
        .soft(
          cancelJobs().map((job) => job.payload),
          'CANCEL jobs queued',
        )
        .toMatchObject([{ taskId, userId: USER }]);
    },
    TEST_TIMEOUT,
  );

  it(
    'P8: keeps the pause of a paused merge that completed while the DELETE waited',
    async () => {
      // The DELETE cancelled nothing, so it clears nothing: the pause is the task's, not the DELETE's.
      const pausedAt = new Date();
      const { taskId, stepRowIds } = await seedTask('running', ['running'], { pausedAt });

      const run = await interleave(
        removeMerge,
        { first: endStepRow(stepRowIds[0]!), second: completeTask(taskId) },
        [],
      );

      expectClean(run);
      expect.soft(run.result, 'the answer').toEqual({
        status: 200,
        body: { ok: true, cancelled: false },
      });
      const task = await taskOf(taskId);
      expect.soft(task.status, 'task status after the DELETE').toBe('completed');
      expect.soft(task.pausedAt, 'paused_at after the DELETE').toEqual(pausedAt);
      expect.soft(cancelJobs(), 'CANCEL jobs queued').toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
