import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.PARK_FOLD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/park_fold_test'))
  throw new Error('Use a dedicated park_fold_test database for the park fold tests');

const USER = '00000000-0000-4000-8000-0000000000f4';
const BLIND_INDEX = 'park-fold-test-user';

const h = vi.hoisted(() => ({ db: undefined as unknown, jobs: [] as string[] }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../worker/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../worker/src/redis.js', () => ({
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add() {}
  },
}));
vi.mock('../src/queues.js', () => {
  const queue = () => ({
    add: async (name: string) => {
      h.jobs.push(name);
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
import { FIX_LOOP_ACTION_FIELD, TASK_JOB_NAMES } from '@haive/shared';
import { computeTaskTiming } from '@haive/shared/timing';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { reofferParkedSteps, settleActiveSteps } from '../src/lib/task-control.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INT4_MAX = 2_147_483_647;
const PARKED_FOR = 10 * MINUTE;
/** The clock gap between a seed and the statement that reads now(), far below any bug's size. */
const SLACK = MINUTE;
const STEP = '08b-test-management';
const TARGET_STEP = '07-phase-2-implement';

const ago = (ms: number) => new Date(Date.now() - ms);

type RowInsert = Partial<typeof schema.taskSteps.$inferInsert>;
/** What a column did: nothing, filled to the int4 maximum, or grew by about that many ms. */
type Moves = 'stays' | 'fills' | number;

const expectMoved = (column: string, before: number, after: number, moves: Moves) => {
  if (moves === 'stays') {
    expect(after, `${column} stays`).toBe(before);
  } else if (moves === 'fills') {
    expect(after, `${column} fills to the int4 maximum`).toBe(INT4_MAX);
  } else {
    expect(after - before, `${column} grows by about ${moves} ms`).toBeGreaterThan(moves - SLACK);
    expect(after - before, `${column} grows by about ${moves} ms`).toBeLessThan(moves + SLACK);
  }
};

type Case = { name: string; seed: () => RowInsert; idle: Moves; carried: Moves };

/** Re-offer closes the span, so both its stored idle and its live wait move to carry. */
const expectCarriedIdle = (
  before: { idleMs: number; carriedIdleMs: number },
  after: { idleMs: number; carriedIdleMs: number; startedAt: Date | null },
  wait: Moves,
) => {
  expect(after.startedAt).toBeNull();
  expect(after.idleMs).toBe(0);
  const prior = before.idleMs + before.carriedIdleMs;
  if (wait === 'fills' || prior + (typeof wait === 'number' ? wait : 0) >= INT4_MAX) {
    expect(after.carriedIdleMs).toBe(INT4_MAX);
  } else {
    expectMoved('carried_idle_ms', prior, after.carriedIdleMs, wait);
  }
};

/** The park-fold matrix shared by the two writers. `started` is the status a row that is inside its
 *  run carries while it holds a marker: the writer's own (a form for a Retry's re-offer, a CLI
 *  step for a Stop). */
const foldCases = (started: 'waiting_form' | 'waiting_cli'): Case[] => [
  {
    name: 'a row parked before its run (pending, marker, started_at NULL) preserves its wait',
    seed: () => ({ status: 'pending', startedAt: null, waitingStartedAt: ago(PARKED_FOR) }),
    idle: 'stays',
    carried: PARKED_FOR,
  },
  {
    name: `a ${started} row (marker, started_at set) preserves its wait (pin)`,
    seed: () => ({ status: started, startedAt: ago(HOUR), waitingStartedAt: ago(PARKED_FOR) }),
    idle: PARKED_FOR,
    carried: 'stays',
  },
  {
    name: 'a pending row holding a marker AND a started_at preserves its wait (pin)',
    seed: () => ({ status: 'pending', startedAt: ago(HOUR), waitingStartedAt: ago(PARKED_FOR) }),
    idle: PARKED_FOR,
    carried: 'stays',
  },
  {
    name: 'a pre-run wait past the int4 range fills carried_idle_ms to 2147483647 instead of raising',
    seed: () => ({
      status: 'pending',
      startedAt: null,
      waitingStartedAt: ago(30 * DAY),
      carriedIdleMs: 0,
    }),
    idle: 'stays',
    carried: 'fills',
  },
  {
    name: 'a pre-run wait on a nearly full carried_idle_ms fills it to 2147483647 instead of raising',
    seed: () => ({
      status: 'pending',
      startedAt: null,
      waitingStartedAt: ago(PARKED_FOR),
      carriedIdleMs: INT4_MAX - 1000,
    }),
    idle: 'stays',
    carried: 'fills',
  },
  {
    name: `a ${started} wait past the int4 range fills the idle counter to 2147483647 (pin)`,
    seed: () => ({
      status: started,
      startedAt: ago(HOUR),
      waitingStartedAt: ago(30 * DAY),
      idleMs: 0,
    }),
    idle: 'fills',
    carried: 'stays',
  },
  {
    name: `a ${started} wait on a nearly full idle_ms saturates without raising (pin)`,
    seed: () => ({
      status: started,
      startedAt: ago(HOUR),
      waitingStartedAt: ago(PARKED_FOR),
      idleMs: INT4_MAX - 1000,
    }),
    idle: 'fills',
    carried: 'stays',
  },
];

const NO_WAIT = 'adds no wait (pin: a missing marker is a wait of 0, not headroom)';

describe.skipIf(!url)('the park wait folded by a Retry re-offer and by a Stop, on Postgres', () => {
  let db: Database;

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

  const seedTask = async (
    status: (typeof schema.tasks.$inferInsert)['status'],
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({
        userId: USER,
        type: 'workflow',
        title: 'park-fold',
        status,
        currentStepId: STEP,
        currentRound: 1,
        orchestrationEpoch: 3,
        ...over,
      })
      .returning();
    return row!;
  };
  const seedRow = async (taskId: string, over: RowInsert = {}) => {
    const [row] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: STEP,
        stepIndex: 8.5,
        runSeq: 2,
        round: 1,
        title: 'Test management',
        status: 'pending',
        idleMs: 1234,
        carriedIdleMs: 4321,
        ...over,
      })
      .returning();
    return row!;
  };
  const rowOf = async (id: string) =>
    (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;

  const reoffer = async (taskId: string) => {
    await db.transaction((tx) => reofferParkedSteps(tx, taskId, new Date(), []));
  };
  const stop = async (taskId: string) => {
    const res = await post(`/tasks/${taskId}/cancel-active-cli`);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.insert(schema.users).values({
      id: USER,
      emailEncrypted: 'park-fold-test@test.local',
      emailBlindIndex: BLIND_INDEX,
      passwordHash: 'not-real',
      role: 'user',
    });
  });

  beforeEach(async () => {
    h.jobs.length = 0;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, USER));
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe.each([
    {
      writer: 'reofferParkedSteps (a task Retry)',
      started: 'waiting_form' as const,
      taskStatus: 'failed' as const,
      run: reoffer,
      endsAs: 'pending',
      unmarked: [
        {
          name: `a waiting_form row with no marker and no started_at ${NO_WAIT}`,
          seed: (): RowInsert => ({ status: 'waiting_form', startedAt: null }),
        },
      ],
    },
    {
      writer: 'failStuckSteps (a Stop)',
      started: 'waiting_cli' as const,
      taskStatus: 'running' as const,
      run: stop,
      endsAs: 'failed',
      unmarked: [
        {
          name: `a pending gate row holding an answer, with no marker and no started_at ${NO_WAIT}`,
          seed: (): RowInsert => ({
            status: 'pending',
            startedAt: null,
            formValues: { [FIX_LOOP_ACTION_FIELD]: 'continue' },
          }),
        },
        {
          name: `a running row with no marker ${NO_WAIT}`,
          seed: (): RowInsert => ({ status: 'running', startedAt: ago(HOUR) }),
        },
      ],
    },
  ])('$writer', ({ started, taskStatus, run, endsAs, unmarked }) => {
    const noWait: Pick<Case, 'idle' | 'carried'> = { idle: 'stays', carried: 'stays' };
    const cases: Case[] = [
      ...foldCases(started),
      ...unmarked.map((u) => ({ name: u.name, seed: u.seed, ...noWait })),
    ];

    it.each(cases)('$name', async ({ seed, idle, carried }) => {
      const task = await seedTask(taskStatus);
      const row = await seedRow(task.id, seed());
      const before = await rowOf(row.id);

      await run(task.id);

      const after = await rowOf(row.id);
      expect(after.status).toBe(endsAs);
      expect(after.waitingStartedAt).toBeNull();
      if (endsAs === 'pending') {
        expectCarriedIdle(before, after, idle === 'stays' ? carried : idle);
      } else {
        expectMoved('idle_ms', before.idleMs, after.idleMs, idle);
        expectMoved('carried_idle_ms', before.carriedIdleMs, after.carriedIdleMs, carried);
      }
    });
  });

  describe('a task Retry through the route, which re-offers the parked rows besides the one it re-runs', () => {
    const retry = async (parked: RowInsert) => {
      const task = await seedTask('failed', { currentStepId: TARGET_STEP, currentRound: 1 });
      await seedRow(task.id, {
        stepId: TARGET_STEP,
        runSeq: 4,
        status: 'failed',
        startedAt: ago(HOUR),
        endedAt: ago(5 * MINUTE),
        errorMessage: 'boom',
      });
      const row = await seedRow(task.id, parked);
      const before = await rowOf(row.id);

      const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      return { before, after: await rowOf(row.id) };
    };

    it('books a row parked before its run to carried_idle_ms, not idle_ms', async () => {
      const { before, after } = await retry({
        status: 'pending',
        startedAt: null,
        waitingStartedAt: ago(PARKED_FOR),
      });

      expect(after.status).toBe('pending');
      expect(after.waitingStartedAt).toBeNull();
      expectCarriedIdle(before, after, PARKED_FOR);
    });

    it('carries the re-offered form wait and closes the prior span before the claim', async () => {
      const { before, after } = await retry({
        status: 'waiting_form',
        startedAt: ago(HOUR),
        waitingStartedAt: ago(PARKED_FOR),
      });

      expect(after.status).toBe('pending');
      expect(after.waitingStartedAt).toBeNull();
      expectCarriedIdle(before, after, PARKED_FOR);
    });
  });

  // A task Retry that never reached a step restarts through START and settles its rows (settleActiveSteps): it
  // fails what is running and re-offers a parked form, as the step Retry above does. The re-offer cleared the
  // park's marker without booking the wait, so the wait left both idle_ms and carried_idle_ms.
  describe('a task Retry that never reached a step, which settles the parked rows before it restarts', () => {
    const settle = async (taskId: string) => {
      await settleActiveSteps(db, taskId);
    };
    // The cases of the shared matrix that start from a form; its pending seeds are failed by this writer, not re-offered.
    const formCases: Case[] = [
      ...foldCases('waiting_form').filter((c) => c.seed().status === 'waiting_form'),
      {
        name: `a waiting_form row with no marker and no started_at ${NO_WAIT}`,
        seed: () => ({ status: 'waiting_form', startedAt: null }),
        idle: 'stays',
        carried: 'stays',
      },
    ];

    it.each(formCases)('$name', async ({ seed, idle, carried }) => {
      const task = await seedTask('failed', { currentStepId: null });
      const row = await seedRow(task.id, seed());
      const before = await rowOf(row.id);

      await settle(task.id);

      const after = await rowOf(row.id);
      expect(after.status).toBe('pending');
      expect(after.waitingStartedAt).toBeNull();
      expectCarriedIdle(before, after, idle === 'stays' ? carried : idle);
    });

    it('carries a form wait once through both settles and closes the prior span', async () => {
      const task = await seedTask('failed', { currentStepId: null });
      const row = await seedRow(task.id, {
        status: 'waiting_form',
        startedAt: ago(HOUR),
        waitingStartedAt: ago(PARKED_FOR),
      });
      const before = await rowOf(row.id);

      const res = await post(`/tasks/${task.id}/action`, { action: 'retry' });

      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      const after = await rowOf(row.id);
      expect(after.status).toBe('pending');
      expect(after.waitingStartedAt).toBeNull();
      expectCarriedIdle(before, after, PARKED_FOR);
    });
  });
  // A re-offer keeps detection, schema and answers, carries the prior timing, and leaves
  // no run open during the pending gap. Evaluate a 30-minute queue delay without sleeping,
  // then exercise the real claim: prior Work stays and only the new execution ticks.
  it.each(['settle through START', 'reoffer'] as const)(
    'A: %s preserves prior Work, excludes a 30-minute pending gap, and books the wait once',
    async (path) => {
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId: USER,
          name: 'claim-trace',
          source: 'local_path',
          localPath: '/tmp',
          storagePath: '/tmp',
          status: 'ready',
        })
        .returning();
      await db
        .insert(schema.taskTypeDefinitions)
        .values({
          slug: 'park_fold_trace',
          displayName: 'park fold trace',
          runListStrategy: 'static',
          source: 'test',
        })
        .onConflictDoNothing();
      const task = await seedTask('failed', {
        currentStepId: null,
        currentRound: 0,
        repositoryId: repo!.id,
        type: 'park_fold_trace',
        runListSnapshot: [STEP],
      });
      const row = await seedRow(task.id, {
        round: 0,
        status: 'waiting_form',
        startedAt: ago(HOUR),
        waitingStartedAt: ago(PARKED_FOR),
        userActiveMs: 600,
        carriedWorkMs: MINUTE,
        carriedUserActiveMs: 200,
      });
      const trace = (phase: string, r: typeof row, at = Date.now()) => {
        const contribution = computeTaskTiming([r], at);
        console.log(
          JSON.stringify({
            path,
            phase,
            status: r.status,
            startedAt: r.startedAt,
            idleMs: r.idleMs,
            carriedIdleMs: r.carriedIdleMs,
            contribution,
          }),
        );
        return contribution;
      };
      const before = trace('0 parked', row);
      if (path === 'settle through START') {
        const response = await post(`/tasks/${task.id}/action`, { action: 'retry' });
        expect(response.status).toBe(200);
        expect(h.jobs).toContain(TASK_JOB_NAMES.START);
      } else {
        await reoffer(task.id);
      }
      const offered = await rowOf(row.id);
      const offeredAt = Date.now();
      const offeredTiming = trace('1 after Retry', offered, offeredAt);
      const delayed = trace('2 after a 30-minute pending gap', offered, offeredAt + 30 * MINUTE);
      expect
        .soft(delayed, 'pending queue time changes neither Work nor booked wait')
        .toEqual(offeredTiming);
      expect.soft(offered.startedAt, 'the old run closes before the pending gap').toBeNull();
      expect.soft(offered.idleMs, 'the previous run idle moves to carried timing').toBe(0);
      expect
        .soft(offered.userActiveMs, 'the previous focused time moves to carried timing')
        .toBe(0);
      // A repeated settle/re-offer sees an unmarked pending row and carries nothing again.
      if (path === 'settle through START') await settleActiveSteps(db, task.id);
      else await reoffer(task.id);
      const repeated = await rowOf(row.id);
      expect(computeTaskTiming([repeated], offeredAt + 30 * MINUTE)).toEqual(delayed);
      // Variable specifiers avoid making the API typecheck include the worker's sources.
      const runnerPath = new URL('../../worker/src/step-engine/step-runner.ts', import.meta.url)
        .pathname;
      const { advanceStep } = await import(runnerPath);
      let claimedAt = 0;
      let after = offered;
      const capture = async () => {
        claimedAt = Date.now();
        after = await rowOf(row.id);
        return {};
      };
      const stepDef = {
        metadata: {
          id: STEP,
          workflowType: 'workflow',
          index: 8.5,
          title: 'resume trace',
          description: 'resume trace',
          requiresCli: false,
        },
        detect: capture,
        // Leave START parked on a form, so this trace needs no terminal cleanup or Docker.
        form: () => ({
          title: 'Trace',
          fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true }],
        }),
        apply: async () => ({}),
      };
      if (path === 'settle through START') {
        const registryPath = new URL('../../worker/src/step-engine/registry.ts', import.meta.url)
          .pathname;
        (await import(registryPath)).stepRegistry.override(stepDef);
        const queuePath = new URL('../../worker/src/queues/task-queue.ts', import.meta.url)
          .pathname;
        await (
          await import(queuePath)
        ).processTaskJob({
          id: task.id,
          name: TASK_JOB_NAMES.START,
          data: { taskId: task.id, userId: USER },
        });
      } else {
        const result = await advanceStep({
          db,
          taskId: task.id,
          userId: USER,
          repoPath: '/tmp',
          workspacePath: '/tmp',
          cliProviderId: null,
          moduleDeactivation: null,
          round: row.round,
          runSeq: row.runSeq,
          stepDef,
        });
        expect(result.status).toBe('waiting_form');
      }
      expect(after.status).toBe('running');
      const workNow = trace('3 after worker claim', after, claimedAt);
      const later = trace('4 five minutes after claim', after, claimedAt + 5 * MINUTE);
      expect
        .soft(later.workMs - workNow.workMs, 'Work advances for all five minutes after the claim')
        .toBe(5 * MINUTE);
      expect.soft(after.startedAt, 'the claim opens a fresh execution span').not.toBeNull();
      expect
        .soft(after.startedAt!.getTime())
        .toBeGreaterThan(row.startedAt!.getTime() + 30 * MINUTE);
      expect
        .soft(workNow.workMs, 'the prior Work is preserved through carry and claim')
        .toBeGreaterThan(before.workMs - SLACK);
      expect
        .soft(workNow.workMs, 'the pending gap adds no Work')
        .toBeLessThan(before.workMs + SLACK);
      expect
        .soft(later.workMs, 'old work and the next five minutes are both retained')
        .toBeGreaterThan(54 * MINUTE);
      expect(after.idleMs).toBe(0);
      expectMoved(
        'carried_idle_ms',
        row.carriedIdleMs,
        after.carriedIdleMs,
        row.idleMs + PARKED_FOR,
      );
      expect(after.carriedWorkMs).toBe(offered.carriedWorkMs);
      expect(after.carriedIdleMs).toBe(offered.carriedIdleMs);
      expect(after.carriedUserActiveMs).toBe(800);
      expect(after.userActiveMs).toBe(0);
      expect(after.waitingStartedAt).toBeNull();
    },
    30_000,
  );

  describe('B: a form park has one marker across the result hand-off', () => {
    const parkedForm = async (merge = false) => {
      const task = await seedTask('running');
      const row = await seedRow(task.id);
      const stepDef = {
        metadata: {
          id: STEP,
          workflowType: 'workflow',
          index: 8.5,
          title: 'stamp trace',
          description: 'stamp trace',
          requiresCli: false,
        },
        detect: async () => ({}),
        form: () => ({
          title: 'Answer',
          fields: [{ name: 'answer', type: 'text', label: 'Answer' }],
        }),
        apply: async () => ({}),
      };
      const runnerPath = new URL('../../worker/src/step-engine/step-runner.ts', import.meta.url)
        .pathname;
      const registryPath = new URL('../../worker/src/step-engine/registry.ts', import.meta.url)
        .pathname;
      const queuePath = new URL('../../worker/src/queues/task-queue.ts', import.meta.url).pathname;
      (await import(registryPath)).stepRegistry.override(stepDef);
      let result = await (
        await import(runnerPath)
      ).advanceStep({
        db,
        taskId: task.id,
        userId: USER,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: null,
        moduleDeactivation: null,
        round: row.round,
        runSeq: row.runSeq,
        stepDef,
      });
      expect(result.status).toBe('waiting_form');
      const reparkMerge = async () => {
        const mergePath = new URL('../../worker/src/step-engine/merge-resolver.ts', import.meta.url)
          .pathname;
        const resolver = await import(mergePath);
        await resolver.recordMergeQuestion(db, task.id, row.id, 'Which side?');
        const fresh = await rowOf(row.id);
        const outcome = await resolver.resolveMergePhase(
          db,
          {
            ...stepDef,
            mergeResolve: {
              selectedMerge: () => true,
              buildClarificationForm: () => ({ title: 'Merge', fields: [] }),
            },
          },
          {
            ...fresh,
            mergeResolveState: {
              mode: 'same-branch',
              phase: 'awaiting-guidance',
              baseBranch: 'main',
              featureBranch: 'feature',
              mergeDir: process.env.TMPDIR,
              sandboxMergeDir: process.env.TMPDIR,
              fixInvocationId: null,
              conflictRetries: 0,
              pendingQuestion: { uncertainty: 'Which side?' },
              pushAfterMerge: false,
              merged: false,
              pushed: false,
              skipReason: null,
            },
          },
          { userId: USER, taskId: task.id },
          { taskId: task.id, userId: USER, epoch: 3 },
        );
        expect(outcome.resolved).toBe(false);
        return outcome.result;
      };
      if (merge) {
        await db
          .update(schema.taskSteps)
          .set({ waitingStartedAt: null })
          .where(eq(schema.taskSteps.id, row.id));
        result = await reparkMerge();
      }
      const hand = () =>
        import(queuePath).then(({ handleResult }) =>
          handleResult(
            db,
            {
              taskId: task.id,
              userId: USER,
              workflowType: 'workflow',
              repoPath: '/tmp',
              workspacePath: '/tmp',
              cliProviderId: null,
              ignoreSavedStepClis: false,
              executionPath: null,
              metadata: null,
              orchestrationEpoch: 3,
              currentStepId: STEP,
              currentRound: row.round,
              status: 'running',
              completedAt: null,
              runListStrategy: 'static',
              runListSnapshot: [STEP],
              customSteps: {},
              fixLoop: null,
              deadAt: null,
            },
            STEP,
            result,
          ),
        );
      return { task, row: result.row as typeof row, hand, reparkMerge };
    };
    const answer = (taskId: string, route: 'submit' | 'clarify') =>
      post(
        `/tasks/${taskId}/steps/${STEP}/${route}`,
        route === 'submit' ? { values: { answer: 'yes' } } : { answer: 'keep both' },
      );
    const afterAnswerRead = (landed: () => Promise<unknown>) => {
      const select = db.select.bind(db);
      let fired = false;
      vi.spyOn(db, 'select').mockImplementation(((...args: unknown[]) => {
        const builder = select(...(args as []));
        const from = builder.from.bind(builder);
        builder.from = ((table: never) => {
          const query = from(table);
          if (table === schema.taskSteps) {
            const limit = query.limit.bind(query);
            query.limit = ((n: number) =>
              Promise.resolve(limit(n)).then(async (rows) => {
                if (!fired) {
                  fired = true;
                  await landed();
                }
                return rows;
              })) as never;
          }
          return query;
        }) as never;
        return builder;
      }) as never);
    };

    it.each(['submit', 'clarify'] as const)(
      '%s accepts an answer read between the standard park and handleResult',
      async (route) => {
        const { task, row, hand } = await parkedForm();
        afterAnswerRead(async () => {
          // Separate M1 and the old M2 deterministically even on a fast database.
          await new Promise((resolve) => setTimeout(resolve, 20));
          await hand();
          expect.soft((await rowOf(row.id)).waitingStartedAt).toEqual(row.waitingStartedAt);
        });
        const response = await answer(task.id, route);
        expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
        expect((await rowOf(row.id)).waitingStartedAt).toBeNull();
      },
      30_000,
    );
    it.each(['submit', 'clarify'] as const)(
      '%s still refuses a real re-park after an answer cleared the old marker',
      async (route) => {
        const { task, row } = await parkedForm();
        afterAnswerRead(async () => {
          expect((await answer(task.id, route)).status).toBe(200);
          await db
            .update(schema.taskSteps)
            .set({
              waitingStartedAt: new Date(Date.now() + 1000),
              formValues: null,
            })
            .where(eq(schema.taskSteps.id, row.id));
        });
        const response = await answer(task.id, route);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'step_form_not_waiting' });
        expect((await rowOf(row.id)).waitingStartedAt).not.toEqual(row.waitingStartedAt);
      },
      30_000,
    );
    it.each([
      ['standard', false, 'submit'],
      ['standard', false, 'clarify'],
      ['merge resolver', true, 'submit'],
      ['merge resolver', true, 'clarify'],
    ] as const)(
      '%s (merge=%s, answer=%s): the hand-off does not reopen an answered marker',
      async (_kind, merge, route) => {
        const { task, row, hand } = await parkedForm(merge);
        expect((await answer(task.id, route)).status).toBe(200);
        expect((await rowOf(row.id)).waitingStartedAt).toBeNull();
        await hand();
        expect((await rowOf(row.id)).waitingStartedAt).toBeNull();
      },
      30_000,
    );
    it('the merge resolver stamps a legitimate new wait after an answer cleared the marker', async () => {
      const { task, row, hand, reparkMerge } = await parkedForm(true);
      expect.soft(row.waitingStartedAt, 'the merge park UPDATE stamps M1').toBeInstanceOf(Date);
      expect((await answer(task.id, 'clarify')).status).toBe(200);
      await hand();
      expect
        .soft((await rowOf(row.id)).waitingStartedAt, 'the stale hand-off leaves the answer closed')
        .toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const next = await reparkMerge();
      expect(next.row.waitingStartedAt).toBeInstanceOf(Date);
      expect(next.row.waitingStartedAt).not.toEqual(row.waitingStartedAt);
    }, 30_000);
  });
});
