import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { autoResumeFailedStep } from '../src/queues/_step-reset.js';
import { resumeStepIfLinked } from '../src/queues/cli-exec/resolvers.js';
import { markCliParkBegin } from '../src/queues/cli-park-timing.js';
import { holdStepAdvance, processTaskJob } from '../src/queues/task-queue.js';
import {
  redriveStalledTasks,
  type FailedStep,
  type StalledRedriveDeps,
  type TaskQueueOwed,
} from '../src/queues/stalled-redrive.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

// The stalled sweep and a running row nothing drives (T385 item 1's twin, and T348): a task whose
// current row is `running` is re-driven once both stamps are older than the cutoff, the task queue
// owes it no job (a START included: it runs the first step inline) and the row has no live run
// (a cli_invocations row of the row with ended_at and superseded_at NULL, started or not), by the same
// fence. Real Postgres, fake queue deps, real clock offsets.

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
  addRefused: false,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
      if (h.addRefused) throw new Error('the queue refused the job');
      h.adds.push({ name, data, opts: opts ?? {} });
    }
  },
}));

const url = process.env.STALLED_RUNNING_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/stalled_running_test'))
  throw new Error('Use a dedicated stalled_running_test database for the stalled running tests');

const TYPE = 'fnf385_stalled_running';
const S = '01-running-step';
const OTHER = '02-other-step';
const NEXT = '03-next-step';
const E = 3;
const ROUND = 1;
const MIN = 60_000;
/** The sweeper's own cutoff: a stamp older than this is overdue. */
const STALE_MS = 5 * MIN;
const OVERDUE = 10 * MIN;
const FRESH = 30_000;
const ago = (offsetMs: number) => new Date(Date.now() - offsetMs);
/** A stamp as a number, whether it is still a Date or came back through JSON as a string. */
const ms = (stamp: Date | string) => new Date(stamp).getTime();
const RATE_LIMITED = 'the provider rate limit was hit';

const calls = { detect: 0, apply: 0 };
function stub(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'workflow' as WorkflowType,
      index,
      title: id,
      description: 'stalled running test stub',
      requiresCli: false,
    },
    async detect() {
      calls.detect++;
      return {};
    },
    form() {
      return { title: id, fields: [] };
    },
    shouldRun() {
      return true;
    },
    async apply() {
      calls.apply++;
      return {};
    },
  } as StepDefinition;
}

interface Advance {
  taskId: string;
  userId: string;
  stepId: string;
  round: number;
  epoch: number;
}

const none = (): TaskQueueOwed => ({ steps: new Set(), starts: new Set() });

/** Fake queue deps. `queued` is the race seam: the sweep reads the queue after its candidate read and
 *  before its fence, so whatever it does to the database lands in that window. */
function rig(
  opts: {
    queued?: () => Promise<TaskQueueOwed | null> | TaskQueueOwed | null;
    /** The runs a cli-exec job still owes, or null when that queue cannot be read. */
    owed?: () => Set<string> | null;
    enqueue?: (advance: Advance) => Promise<void>;
    retryDelaysMs?: number[];
  } = {},
) {
  const advances: Advance[] = [];
  const failed: FailedStep[] = [];
  const seen = { seam: 0, attempts: 0, start: 0 };
  const deps: StalledRedriveDeps = {
    enqueueAdvance: async (taskId, userId, stepId, round, epoch) => {
      seen.attempts++;
      const advance = { taskId, userId, stepId, round, epoch };
      await opts.enqueue?.(advance);
      advances.push(advance);
    },
    failTask: async (_db, step) => {
      failed.push(step);
      return true;
    },
    enqueueStart: async () => {
      seen.start++;
    },
    queuedTaskJobs: async () => {
      seen.seam++;
      return opts.queued ? await opts.queued() : none();
    },
    queuedInvocationIds: async () => (opts.owed ? opts.owed() : new Set<string>()),
    redriveRetryDelaysMs: opts.retryDelaysMs ?? [],
  };
  return { deps, advances, failed, seen };
}

describe.skipIf(!url)('the stalled sweep and a running row nothing drives, on Postgres', () => {
  const EMAIL_INDEX = 'stalled-running-test-user';
  let db: Database;
  let userId: string;
  let repositoryId: string;

  const job = (name: string, data: Record<string, unknown>) =>
    ({
      id: randomUUID(),
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];

  const seedTask = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: TYPE,
        title: 'stalled running',
        status: 'running',
        orchestrationEpoch: E,
        currentStepId: S,
        currentRound: ROUND,
        runListSnapshot: [S, OTHER, NEXT],
        createdAt: ago(2 * OVERDUE),
        updatedAt: ago(OVERDUE),
        ...over,
      })
      .returning({ id: schema.tasks.id });
    return made!.id;
  };
  const seedRow = async (
    taskId: string,
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const [made] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: S,
        stepIndex: 1,
        runSeq: 0,
        round: ROUND,
        title: S,
        status: 'running',
        startedAt: ago(2 * OVERDUE),
        createdAt: ago(2 * OVERDUE),
        updatedAt: ago(OVERDUE),
        ...over,
      })
      .returning({ id: schema.taskSteps.id });
    return made!.id;
  };
  const seedRun = async (
    taskId: string,
    rowId: string,
    over: Partial<typeof schema.cliInvocations.$inferInsert> = {},
  ) => {
    const [made] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId,
        taskStepId: rowId,
        mode: 'cli',
        prompt: 'stalled running test',
        createdAt: ago(OVERDUE),
        ...over,
      })
      .returning({ id: schema.cliInvocations.id });
    return made!.id;
  };
  /** A task on a running row, both stamps overdue unless the overrides say otherwise. */
  const running = async (
    taskOver: Partial<typeof schema.tasks.$inferInsert> = {},
    rowOver: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const taskId = await seedTask(taskOver);
    const rowId = await seedRow(taskId, rowOver);
    return { taskId, rowId };
  };

  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const state = async (taskId: string) => {
    const steps = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(asc(schema.taskSteps.stepId));
    return {
      task: plain((await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!),
      steps: plain(steps),
      events: plain(
        await db
          .select()
          .from(schema.taskEvents)
          .where(eq(schema.taskEvents.taskId, taskId))
          .orderBy(asc(schema.taskEvents.createdAt)),
      ),
      runs: plain(
        await db
          .select()
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.taskId, taskId))
          .orderBy(asc(schema.cliInvocations.id)),
      ),
      minings: plain(
        steps.length === 0
          ? []
          : await db
              .select()
              .from(schema.taskStepAgentMinings)
              .where(
                inArray(
                  schema.taskStepAgentMinings.taskStepId,
                  steps.map((step) => step.id),
                ),
              )
              .orderBy(asc(schema.taskStepAgentMinings.agentId)),
      ),
    };
  };
  type State = Awaited<ReturnType<typeof state>>;
  const withoutFence = (task: State['task']) => {
    const { orchestrationEpoch: _epoch, updatedAt: _stamp, ...rest } = task;
    return rest;
  };
  const epochOf = async (taskId: string) => (await state(taskId)).task.orchestrationEpoch;

  /** The re-drive's whole effect: the epoch up by one, the task stamped, one advance at the new
   *  epoch for the step the task points at, and not a byte written anywhere else. */
  const expectRedriven = async (
    taskId: string,
    before: State,
    advances: Advance[],
    epoch = E + 1,
  ) => {
    const after = await state(taskId);
    expect(after.task.orchestrationEpoch, 'the fence moved the epoch up by one').toBe(epoch);
    expect(
      ms(after.task.updatedAt),
      'the fence stamped the task, which throttles the next pass',
    ).toBeGreaterThan(ms(before.task.updatedAt));
    expect(withoutFence(after.task), 'nothing else on the task row changed').toEqual(
      withoutFence(before.task),
    );
    expect(after.steps, 'the re-drive wrote nothing to the step rows').toEqual(before.steps);
    expect(after.runs, 'the re-drive touched no run').toEqual(before.runs);
    expect(after.minings, 'the re-drive touched no agent row').toEqual(before.minings);
    expect(after.events, 'the re-drive wrote no event').toEqual(before.events);
    expect(advances, 'exactly one advance, at the new epoch').toEqual([
      { taskId, userId, stepId: S, round: ROUND, epoch },
    ]);
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'stalled-running-test@test.local',
        emailBlindIndex: EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'stalled-running',
        source: 'local_path',
        localPath: os.tmpdir(),
        storagePath: os.tmpdir(),
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;
    await db
      .insert(schema.taskTypeDefinitions)
      .values({ slug: TYPE, displayName: TYPE, runListStrategy: 'static', source: 'test' })
      .onConflictDoNothing();
    stepRegistry.override(stub(S, 1));
    stepRegistry.override(stub(OTHER, 2));
    stepRegistry.override(stub(NEXT, 3));
  });

  beforeEach(async () => {
    h.adds.length = 0;
    h.addRefused = false;
    calls.detect = calls.apply = 0;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  /** The T348 shape: a loop step whose provider outage failed the task, then the usage poller's
   *  `autoResumeFailedStep` flipped task and row back to `running` in its transaction. */
  const autoResumed = async () => {
    const taskId = await seedTask({
      status: 'failed',
      errorMessage: RATE_LIMITED,
      completedAt: ago(OVERDUE),
      awaitingProviderReason: 'rate_limit',
      awaitingProviderSince: ago(OVERDUE),
    });
    const rowId = await seedRow(taskId, {
      status: 'failed',
      errorMessage: RATE_LIMITED,
      endedAt: ago(OVERDUE),
      detectOutput: { kept: 'detect' },
      iterationCount: 1,
      iterations: [
        {
          iteration: 0,
          llmOutput: null,
          applyOutput: null,
          continueRequested: true,
          recordedAt: ago(OVERDUE).toISOString(),
        },
      ],
    });
    await seedRun(taskId, rowId, {
      exitCode: 1,
      errorMessage: RATE_LIMITED,
      startedAt: ago(OVERDUE + MIN),
      endedAt: ago(OVERDUE),
    });
    const resumed = await autoResumeFailedStep(db, {
      taskId,
      stepId: S,
      round: ROUND,
      providerId: null,
      via: 'test',
      watchSince: null,
    });
    expect(resumed, 'the poller auto-resumed the failed step').toBe(true);
    const after = await state(taskId);
    expect(after.task).toMatchObject({ status: 'running', orchestrationEpoch: E });
    expect(after.steps[0]).toMatchObject({ status: 'running' });
    return { taskId, rowId };
  };
  const clockMovedBack = async (taskId: string, rowId: string) => {
    await db
      .update(schema.tasks)
      .set({ updatedAt: ago(OVERDUE) })
      .where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.taskSteps)
      .set({ updatedAt: ago(OVERDUE) })
      .where(eq(schema.taskSteps.id, rowId));
  };

  describe('a running row that is overdue, unqueued and has no live run', () => {
    it('R1: is re-driven once, at the next epoch, and the sweep writes nothing', async () => {
      const { taskId } = await running();
      const before = await state(taskId);
      // A job queued for ANOTHER task, and a START for a third, hold nothing of this one.
      const { deps, advances, seen } = rig({
        queued: () => ({ steps: new Set([randomUUID()]), starts: new Set([randomUUID()]) }),
      });
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the idle running row',
      ).resolves.toBe(1);
      expect(seen.seam, 'the queue was read once').toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('R2: is re-driven when its only run has ended', async () => {
      const { taskId, rowId } = await running();
      await seedRun(taskId, rowId, {
        exitCode: 0,
        startedAt: ago(9 * MIN),
        endedAt: ago(8 * MIN),
      });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'an ended run holds nothing',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('R3: is re-driven when its only run was superseded', async () => {
      const { taskId, rowId } = await running();
      await seedRun(taskId, rowId, { startedAt: ago(9 * MIN), supersededAt: ago(8 * MIN) });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'a superseded run holds nothing',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('R4: the T348 shape (a failed loop step auto-resumed, its advance never queued) is left alone while fresh, then re-driven once', async () => {
      const { taskId, rowId } = await autoResumed();
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'right after the auto-resume both stamps are fresh',
      ).resolves.toBe(0);

      await clockMovedBack(taskId, rowId);
      const before = await state(taskId);
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'ten minutes on, with no job, the sweep took the auto-resumed row',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('R5: is re-driven when it is a fan-out row with pending and running agent rows but no live run, writing nothing to the row', async () => {
      const { taskId, rowId } = await running();
      const endedRun = await seedRun(taskId, rowId, {
        mode: 'agent_mining',
        exitCode: 0,
        startedAt: ago(9 * MIN),
        endedAt: ago(8 * MIN),
      });
      await db.insert(schema.taskStepAgentMinings).values([
        { taskStepId: rowId, agentId: 'agent-reserved', status: 'pending' },
        {
          taskStepId: rowId,
          agentId: 'agent-running',
          status: 'running',
          cliInvocationId: endedRun,
        },
      ]);
      const before = await state(taskId);
      expect(before.minings, 'the fan-out seeds are in place').toHaveLength(2);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'agent rows never hold a running row',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('R6: is re-driven when the only live run belongs to ANOTHER row of the task', async () => {
      const { taskId } = await running();
      const otherRow = await seedRow(taskId, { stepId: OTHER, stepIndex: 2, status: 'done' });
      await seedRun(taskId, otherRow, { startedAt: ago(8 * MIN) });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'a run of another row is not a live run of this row',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('R7: is re-driven at boot (staleMs 0) though both stamps are fresh, when no job exists', async () => {
      const { taskId } = await running({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: 0 }),
        'boot took the running row whose job is gone',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });
  });

  describe('a running row the sweep leaves alone', () => {
    interface Alone {
      id: string;
      why: string;
      seed: () => Promise<string>;
      queued?: (taskId: string) => TaskQueueOwed | null;
      staleMs?: number;
    }
    const live = async (
      mode: (typeof schema.cliInvocations.$inferInsert)['mode'],
      started: boolean,
      over: Partial<typeof schema.taskSteps.$inferInsert> = {},
      taskOver: Partial<typeof schema.tasks.$inferInsert> = {},
    ) => {
      const { taskId, rowId } = await running(taskOver, over);
      await seedRun(taskId, rowId, { mode, startedAt: started ? ago(8 * MIN) : null });
      return taskId;
    };
    const modes = ['cli', 'agent_mining', 'dag_parallel'] as const;
    it.each(modes.flatMap((mode) => [true, false].map((started) => ({ mode, started }))))(
      'a live $mode run (started: $started) never enters the task-locking fence',
      async ({ mode, started }) => {
        const taskId = await live(mode, started);
        const before = await state(taskId);
        const transaction = vi.spyOn(db, 'transaction');
        const { deps, advances } = rig();
        try {
          await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
          expect(
            transaction,
            'no candidate reached the fence, so no task row was locked',
          ).not.toHaveBeenCalled();
          expect(advances).toEqual([]);
          expect(await state(taskId)).toEqual(before);
        } finally {
          transaction.mockRestore();
        }
      },
    );
    const statuses = ['waiting_user', 'waiting_pr', 'failed', 'paused'] as const;
    const ALONE: Alone[] = [
      ...modes.flatMap((mode, index) =>
        [true, false].map((started) => ({
          id: `L1.${index * 2 + (started ? 1 : 2)}`,
          why: `a live ${started ? 'started' : 'queued, unstarted'} ${mode} run belongs to the row`,
          seed: () => live(mode, started),
        })),
      ),
      {
        id: 'L2',
        why: 'the queue holds a job for the task',
        seed: async () => (await running()).taskId,
        queued: (taskId) => ({ steps: new Set([taskId]), starts: new Set() }),
      },
      {
        id: 'L3',
        why: 'the queue holds a START for the task, whose job runs the first step inline',
        seed: async () => (await running()).taskId,
        queued: (taskId) => ({ steps: new Set(), starts: new Set([taskId]) }),
      },
      {
        id: 'L4',
        why: 'its row stamp is fresh',
        seed: async () => (await running({}, { updatedAt: ago(FRESH) })).taskId,
      },
      {
        id: 'L5',
        why: 'its own stamp is fresh',
        seed: async () => (await running({ updatedAt: ago(FRESH) })).taskId,
      },
      {
        id: 'L6',
        why: 'the row is waiting_cli and a started run is live on it',
        seed: () => live('cli', true, { status: 'waiting_cli' }),
      },
      {
        id: 'L7',
        why: 'the task is dead',
        seed: async () => (await running({ deadAt: ago(OVERDUE) })).taskId,
      },
      ...statuses.map((status, index) => ({
        id: `L8.${index + 1}`,
        why: `the task is ${status}, not running`,
        seed: async () => (await running({ status })).taskId,
      })),
      {
        id: 'L9',
        why: 'the task queue cannot be read',
        seed: async () => (await running()).taskId,
        queued: () => null,
      },
      {
        id: 'L10',
        why: 'boot finds a live run on the row',
        seed: () => live('cli', true, { updatedAt: ago(5_000) }, { updatedAt: ago(5_000) }),
        staleMs: 0,
      },
      {
        id: 'L11',
        why: 'boot finds its job still queued',
        seed: async () =>
          (await running({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) })).taskId,
        queued: (taskId) => ({ steps: new Set([taskId]), starts: new Set() }),
        staleMs: 0,
      },
      {
        id: 'L12',
        why: 'boot finds its START queued',
        seed: async () =>
          (await running({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) })).taskId,
        queued: (taskId) => ({ steps: new Set(), starts: new Set([taskId]) }),
        staleMs: 0,
      },
      {
        id: 'L13',
        why: 'the row is a parked FORM (waiting_form with a marker)',
        seed: async () =>
          (await running({}, { status: 'waiting_form', waitingStartedAt: ago(12 * MIN) })).taskId,
      },
    ];

    it.each(ALONE)('$id: takes nothing when $why', async ({ seed, queued, staleMs }) => {
      const taskId = await seed();
      const before = await state(taskId);
      const { deps, advances, failed, seen } = rig(queued ? { queued: () => queued(taskId) } : {});
      await expect(redriveStalledTasks(db, deps, { staleMs: staleMs ?? STALE_MS })).resolves.toBe(
        0,
      );
      expect(advances, 'nothing was queued').toEqual([]);
      expect(failed, 'no task was failed').toEqual([]);
      expect(seen.start, 'no START was queued').toBe(0);
      expect(await state(taskId), 'nothing was written').toEqual(before);
    });
  });

  describe('a step a pass of this process is on, whose job Redis lost', () => {
    it('L14: is left alone while the pass holds the step, and taken once the hold is released', async () => {
      const { taskId } = await running();
      const before = await state(taskId);
      const release = await holdStepAdvance(
        {
          id: randomUUID(),
          data: { taskId, userId, stepId: S, round: ROUND },
          moveToDelayed: async () => undefined,
        },
        undefined,
      );
      const held = rig();
      await expect(redriveStalledTasks(db, held.deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(held.advances, 'nothing was queued while a pass held the step').toEqual([]);
      expect(await state(taskId), 'and nothing was written').toEqual(before);
      release!();
      const free = rig();
      await expect(redriveStalledTasks(db, free.deps, { staleMs: STALE_MS })).resolves.toBe(1);
      expect(free.advances, 'the hold, not the row, was what protected it').toHaveLength(1);
    });
  });

  describe("a row the running re-drive does not change the handling of (pins: today's rules)", () => {
    it('K1: a failed current row is failed through the task, never re-driven', async () => {
      const { taskId, rowId } = await running(
        {},
        { status: 'failed', errorMessage: 'cli invocation failed: boom', endedAt: ago(OVERDUE) },
      );
      const before = await state(taskId);
      const { deps, advances, failed } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      expect(failed).toEqual([
        { taskId, epoch: E, stepId: S, rowId, message: 'cli invocation failed: boom' },
      ]);
      expect(advances, 'no advance for a failed row').toEqual([]);
      expect(await state(taskId), 'the sweep wrote nothing itself').toEqual(before);
    });

    it('K2: a done current row, its hand-off lost, is re-driven once', async () => {
      const { taskId } = await running({}, { status: 'done', endedAt: ago(OVERDUE) });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('K3: an answered form (waiting_form, no marker) is re-driven once', async () => {
      const { taskId } = await running({}, { status: 'waiting_form' });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });
  });

  describe('the fence, against what happens between the candidate read and the fence', () => {
    interface Race {
      id: string;
      what: string;
      epoch: number;
      mutate: (taskId: string, rowId: string) => Promise<unknown>;
    }
    const onTask = (taskId: string) => eq(schema.tasks.id, taskId);
    const onRow = (rowId: string) => eq(schema.taskSteps.id, rowId);
    const RACES: Race[] = [
      {
        id: 'Q1',
        what: 'a queued, unstarted run is recorded for the row',
        epoch: E,
        mutate: async (taskId, rowId) => {
          await seedRun(taskId, rowId, { createdAt: new Date() });
        },
      },
      {
        id: 'Q2',
        what: 'a started agent run is recorded for the row',
        epoch: E,
        mutate: async (taskId, rowId) => {
          await seedRun(taskId, rowId, {
            mode: 'agent_mining',
            createdAt: new Date(),
            startedAt: new Date(),
          });
        },
      },
      {
        id: 'Q3',
        what: 'a pass writes the row',
        epoch: E,
        mutate: (_t, rowId) =>
          db.update(schema.taskSteps).set({ updatedAt: new Date() }).where(onRow(rowId)),
      },
      {
        id: 'Q4',
        what: 'a pass parks the row on its run',
        epoch: E,
        mutate: (_t, rowId) =>
          db
            .update(schema.taskSteps)
            .set({ status: 'waiting_cli', updatedAt: new Date() })
            .where(onRow(rowId)),
      },
      {
        id: 'Q5',
        what: 'a Resume moves the epoch',
        epoch: E + 1,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ orchestrationEpoch: E + 1 })
            .where(onTask(taskId)),
      },
      {
        id: 'Q6',
        what: 'the pointer moves to another step',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ currentStepId: OTHER }).where(onTask(taskId)),
      },
      {
        id: 'Q7',
        what: 'the pointer moves to another round',
        epoch: E,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ currentRound: ROUND + 1 })
            .where(onTask(taskId)),
      },
      {
        id: 'Q8',
        what: 'the task is stamped',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ updatedAt: new Date() }).where(onTask(taskId)),
      },
      {
        id: 'Q9',
        what: 'a Stop fails the task',
        epoch: E,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ status: 'failed', errorMessage: 'Stopped by user' })
            .where(onTask(taskId)),
      },
      {
        id: 'Q10',
        what: 'the task is marked dead',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ deadAt: new Date() }).where(onTask(taskId)),
      },
    ];

    it.each(RACES)('$id: no bump and no enqueue when $what', async ({ mutate, epoch }) => {
      const { taskId, rowId } = await running();
      const { deps, advances, seen } = rig({
        queued: async () => {
          await mutate(taskId, rowId);
          return none();
        },
      });
      const redriven = await redriveStalledTasks(db, deps, { staleMs: STALE_MS });
      expect(seen.seam, 'the candidate was read and the race window was reached').toBe(1);
      expect(redriven, 'the fence refused').toBe(0);
      expect(advances, 'nothing was queued').toEqual([]);
      expect(await epochOf(taskId), 'no epoch bump of the sweep').toBe(epoch);
    });
  });

  describe('throttle and failure', () => {
    it('F1: a second pass right after a re-drive does nothing', async () => {
      const { taskId } = await running();
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the first pass re-drove',
      ).resolves.toBe(1);
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(advances, 'one advance in all').toHaveLength(1);
      expect(await epochOf(taskId), 'one bump in all').toBe(E + 1);
    });

    it('F2: an enqueue that keeps failing hands the epoch back, and the next overdue pass re-drives', async () => {
      const { taskId } = await running();
      let refusing = true;
      const { deps, advances, seen } = rig({
        retryDelaysMs: [0, 0],
        enqueue: async () => {
          if (refusing) throw new Error('the queue refused the job');
        },
      });
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(seen.attempts, 'the sweep tried to queue the re-drive').toBeGreaterThanOrEqual(1);
      expect(await epochOf(taskId), 'the epoch is the one the sweep read').toBe(E);

      // The hand-back stamps the task; it is overdue again a cutoff later.
      refusing = false;
      await db
        .update(schema.tasks)
        .set({ updatedAt: ago(OVERDUE) })
        .where(eq(schema.tasks.id, taskId));
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      expect(advances).toEqual([{ taskId, userId, stepId: S, round: ROUND, epoch: E + 1 }]);
    });
  });

  describe('the re-driven job, run by the real handler', () => {
    it('E1: runs the step once and hands off with no deduplication id; the old-epoch job is dropped and the step does not run again', async () => {
      const { taskId } = await running();
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the running row',
      ).resolves.toBe(1);
      const redrive = advances[0]!;
      expect(redrive).toEqual({ taskId, userId, stepId: S, round: ROUND, epoch: E + 1 });

      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { ...redrive }));
      expect(calls.apply, 'the re-driven job ran the step once').toBe(1);
      const finished = (await state(taskId)).steps.find((step) => step.stepId === S);
      expect(finished?.status).toBe('done');
      const handoffs = h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);
      expect(handoffs, 'one hand-off, to the next step of the run list').toHaveLength(1);
      expect(handoffs[0]!.data).toMatchObject({ taskId, stepId: OTHER });
      expect(
        handoffs[0]!.opts.deduplication,
        'the forward hand-off carries no deduplication id',
      ).toBeUndefined();

      // The advance the sweep replaced turns up again, still at the epoch the sweep read.
      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: S, round: ROUND, epoch: E }),
      );
      expect(calls.apply, 'the old-epoch job was dropped: the step did not run again').toBe(1);
      expect(
        h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP),
        'and it handed nothing off',
      ).toHaveLength(1);
    });

    it('E2: an advance with no epoch (as the usage poller queues one) after the re-driven pass is dropped too', async () => {
      const { taskId } = await running();
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the running row',
      ).resolves.toBe(1);
      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { ...advances[0]! }));
      expect(calls.apply, 'the re-driven job ran the step once').toBe(1);

      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: S, round: ROUND }),
      );
      expect(calls.apply, 'the task has moved past the step: the job is dropped').toBe(1);
      expect(
        h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP),
        'and it handed nothing off',
      ).toHaveLength(1);
    });

    it('E3: an advance of the old epoch that arrives BEFORE the re-driven job is dropped, and the re-driven job then runs the step once', async () => {
      const { taskId } = await running();
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the running row',
      ).resolves.toBe(1);

      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: S, round: ROUND, epoch: E }),
      );
      expect(calls.apply, 'the old-epoch job did not run the step').toBe(0);
      expect(h.adds, 'and handed nothing off').toEqual([]);

      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { ...advances[0]! }));
      expect(calls.apply, 'the re-driven job ran the step once').toBe(1);
    });
  });

  /** A task on a step parked on its CLI, both stamps overdue and the row marked as `markCliParkBegin`
   *  leaves it when the last run ended (the wait is open, the row stamped then). */
  const parkedOnCli = (
    taskOver: Partial<typeof schema.tasks.$inferInsert> = {},
    rowOver: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) =>
    running(taskOver, {
      status: 'waiting_cli',
      statusMessage: 'Waiting for AI analysis...',
      waitingStartedAt: ago(OVERDUE),
      ...rowOver,
    });
  const endedRun = (
    taskId: string,
    rowId: string,
    over: Partial<typeof schema.cliInvocations.$inferInsert> = {},
  ) =>
    seedRun(taskId, rowId, {
      exitCode: 0,
      startedAt: ago(OVERDUE + MIN),
      endedAt: ago(OVERDUE),
      ...over,
    });

  describe('a waiting_cli row whose runs have all ended, and whose continuation add was lost', () => {
    it('W1: is re-driven once, at the next epoch, and the sweep writes nothing', async () => {
      const { taskId, rowId } = await parkedOnCli();
      await endedRun(taskId, rowId);
      const before = await state(taskId);
      // A job queued for ANOTHER task, and a START for a third, hold nothing of this one.
      const { deps, advances, seen } = rig({
        queued: () => ({ steps: new Set([randomUUID()]), starts: new Set([randomUUID()]) }),
      });
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the parked row whose only run ended',
      ).resolves.toBe(1);
      expect(seen.seam, 'the queue was read once').toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('W2: is re-driven when its only run was superseded', async () => {
      const { taskId, rowId } = await parkedOnCli();
      await seedRun(taskId, rowId, { startedAt: ago(9 * MIN), supersededAt: ago(8 * MIN) });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('W3: is re-driven when it has no run at all', async () => {
      const { taskId } = await parkedOnCli();
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('W4: is re-driven when it is a fan-out row whose agents all ended, writing nothing to the row or its agents', async () => {
      const { taskId, rowId } = await parkedOnCli();
      const first = await endedRun(taskId, rowId, { mode: 'agent_mining' });
      const second = await endedRun(taskId, rowId, { mode: 'agent_mining', exitCode: 1 });
      await db.insert(schema.taskStepAgentMinings).values([
        { taskStepId: rowId, agentId: 'agent-done', status: 'done', cliInvocationId: first },
        { taskStepId: rowId, agentId: 'agent-failed', status: 'failed', cliInvocationId: second },
      ]);
      const before = await state(taskId);
      expect(before.minings, 'the fan-out seeds are in place').toHaveLength(2);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('W5: is re-driven when the row carries no park marker, since the marker is not what makes it stuck', async () => {
      const { taskId, rowId } = await parkedOnCli({}, { waitingStartedAt: null });
      await endedRun(taskId, rowId);
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('W6: is re-driven at boot (staleMs 0) though both stamps are fresh, when no job exists', async () => {
      const { taskId, rowId } = await parkedOnCli(
        { updatedAt: ago(5_000) },
        { updatedAt: ago(5_000) },
      );
      await endedRun(taskId, rowId);
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: 0 })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('WP1: leaves a row whose last run just ended to its continuation, since the end of a run stamps the row', async () => {
      const { taskId, rowId } = await parkedOnCli({}, { waitingStartedAt: null });
      await endedRun(taskId, rowId, { endedAt: new Date() });
      // What the cli-exec handler does as the last run ends, ahead of queueing the continuation.
      await markCliParkBegin(db, rowId);
      const before = await state(taskId);
      expect(
        ms(before.steps[0]!.updatedAt),
        'the row was stamped as the run ended, so the cutoff counts from there',
      ).toBeGreaterThan(Date.now() - FRESH);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(advances).toEqual([]);
      expect(await state(taskId), 'and nothing was written').toEqual(before);
    });

    it('W7: is what a refused continuation add leaves behind, and the sweep takes it', async () => {
      const { taskId, rowId } = await parkedOnCli();
      const runId = await endedRun(taskId, rowId);
      h.addRefused = true;
      await expect(
        resumeStepIfLinked(
          { invocationId: runId, taskStepId: rowId, taskId, userId } as unknown as Parameters<
            typeof resumeStepIfLinked
          >[0],
          true,
          null,
        ),
        'the run ended and its continuation could not be queued',
      ).rejects.toThrow('the queue refused the job');
      h.addRefused = false;
      expect(h.adds, 'no job exists for the task').toEqual([]);
      const before = await state(taskId);
      expect(before.steps[0]).toMatchObject({ status: 'waiting_cli' });
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the stranded row is taken between boots',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });
  });

  describe('a waiting_cli row the sweep leaves alone', () => {
    interface Alone {
      id: string;
      why: string;
      seed: () => Promise<string>;
      queued?: (taskId: string) => TaskQueueOwed | null;
      owed?: () => Set<string> | null;
      staleMs?: number;
    }
    /** The runs a cli-exec job owes, for the cases that say so. */
    const owedRuns = new Set<string>();
    beforeEach(() => owedRuns.clear());
    const withRun = async (
      over: Partial<typeof schema.cliInvocations.$inferInsert>,
      taskOver: Partial<typeof schema.tasks.$inferInsert> = {},
      rowOver: Partial<typeof schema.taskSteps.$inferInsert> = {},
    ) => {
      const { taskId, rowId } = await parkedOnCli(taskOver, rowOver);
      const runId = await seedRun(taskId, rowId, over);
      return { taskId, runId };
    };
    const statuses = ['waiting_user', 'waiting_pr', 'failed', 'paused'] as const;
    const ALONE: Alone[] = [
      {
        id: 'WL1',
        why: 'a started cli run is live on the row: a worker is behind the step',
        seed: async () => (await withRun({ startedAt: ago(8 * MIN) })).taskId,
      },
      {
        id: 'WL2',
        why: 'a started agent run is live beside an ended one',
        seed: async () => {
          const { taskId, rowId } = await parkedOnCli();
          await endedRun(taskId, rowId, { mode: 'agent_mining' });
          await seedRun(taskId, rowId, { mode: 'agent_mining', startedAt: ago(8 * MIN) });
          return taskId;
        },
      },
      {
        id: 'WL3',
        why: 'an unstarted run is live and a cli-exec job still owes it',
        seed: async () => {
          const { taskId, runId } = await withRun({});
          owedRuns.add(runId);
          return taskId;
        },
        owed: () => owedRuns,
      },
      {
        id: 'WL4',
        why: 'an unstarted run was recorded within the cutoff, which a live worker may still be starting',
        seed: async () => (await withRun({ createdAt: new Date() })).taskId,
      },
      {
        id: 'WL5',
        why: 'an unstarted run is live and the cli-exec queue cannot be read',
        seed: async () => (await withRun({})).taskId,
        owed: () => null,
      },
      {
        id: 'WL6',
        why: 'the queue holds a job for the task',
        seed: async () => (await parkedOnCli()).taskId,
        queued: (taskId) => ({ steps: new Set([taskId]), starts: new Set() }),
      },
      {
        id: 'WL7',
        why: 'the queue holds a START for the task, whose job runs the first step inline',
        seed: async () => (await parkedOnCli()).taskId,
        queued: (taskId) => ({ steps: new Set(), starts: new Set([taskId]) }),
      },
      {
        id: 'WL8',
        why: 'its row stamp is fresh: the run just ended and its continuation is on its way',
        seed: async () => (await parkedOnCli({}, { updatedAt: ago(FRESH) })).taskId,
      },
      {
        id: 'WL9',
        why: 'its own stamp is fresh',
        seed: async () => (await parkedOnCli({ updatedAt: ago(FRESH) })).taskId,
      },
      {
        id: 'WL10',
        why: 'the task is dead',
        seed: async () => (await parkedOnCli({ deadAt: ago(OVERDUE) })).taskId,
      },
      ...statuses.map((status, index) => ({
        id: `WL11.${index + 1}`,
        why: `the task is ${status}, not running`,
        seed: async () => (await parkedOnCli({ status })).taskId,
      })),
      {
        id: 'WL12',
        why: 'the task queue cannot be read',
        seed: async () => (await parkedOnCli()).taskId,
        queued: () => null,
      },
      {
        id: 'WL13',
        why: 'boot finds a live run on the row',
        seed: async () =>
          (
            await withRun(
              { startedAt: ago(8 * MIN) },
              { updatedAt: ago(5_000) },
              { updatedAt: ago(5_000) },
            )
          ).taskId,
        staleMs: 0,
      },
      {
        id: 'WL14',
        why: 'boot finds its job still queued',
        seed: async () =>
          (await parkedOnCli({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) })).taskId,
        queued: (taskId) => ({ steps: new Set([taskId]), starts: new Set() }),
        staleMs: 0,
      },
      {
        id: 'WL15',
        why: 'boot finds its START queued',
        seed: async () =>
          (await parkedOnCli({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) })).taskId,
        queued: (taskId) => ({ steps: new Set(), starts: new Set([taskId]) }),
        staleMs: 0,
      },
    ];

    it.each(ALONE)('$id: takes nothing when $why', async ({ seed, queued, owed, staleMs }) => {
      const taskId = await seed();
      const before = await state(taskId);
      const { deps, advances, failed, seen } = rig({
        ...(queued ? { queued: () => queued(taskId) } : {}),
        ...(owed ? { owed } : {}),
      });
      await expect(redriveStalledTasks(db, deps, { staleMs: staleMs ?? STALE_MS })).resolves.toBe(
        0,
      );
      expect(advances, 'nothing was queued').toEqual([]);
      expect(failed, 'no task was failed').toEqual([]);
      expect(seen.start, 'no START was queued').toBe(0);
      expect(await state(taskId), 'nothing was written').toEqual(before);
    });

    it.each([
      { mode: 'cli' as const, started: true },
      { mode: 'agent_mining' as const, started: true },
      { mode: 'dag_parallel' as const, started: true },
    ])('WL16: a live $mode run never enters the task-locking fence', async ({ mode }) => {
      const { taskId } = await withRun({ mode, startedAt: ago(8 * MIN) });
      const before = await state(taskId);
      const transaction = vi.spyOn(db, 'transaction');
      const { deps, advances } = rig();
      try {
        await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
        expect(
          transaction,
          'no candidate reached the fence, so no task row was locked',
        ).not.toHaveBeenCalled();
        expect(advances).toEqual([]);
        expect(await state(taskId)).toEqual(before);
      } finally {
        transaction.mockRestore();
      }
    });
  });

  describe('a waiting_cli step a pass of this process is on, whose job Redis lost', () => {
    it('WH1: is left alone while the pass holds the step, and taken once the hold is released', async () => {
      const { taskId, rowId } = await parkedOnCli();
      await endedRun(taskId, rowId);
      const before = await state(taskId);
      const release = await holdStepAdvance(
        {
          id: randomUUID(),
          data: { taskId, userId, stepId: S, round: ROUND },
          moveToDelayed: async () => undefined,
        },
        undefined,
      );
      const held = rig();
      await expect(redriveStalledTasks(db, held.deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(held.advances, 'nothing was queued while a pass held the step').toEqual([]);
      expect(await state(taskId), 'and nothing was written').toEqual(before);
      release!();
      const free = rig();
      await expect(redriveStalledTasks(db, free.deps, { staleMs: STALE_MS })).resolves.toBe(1);
      expect(free.advances, 'the hold, not the row, was what protected it').toHaveLength(1);
    });
  });

  describe('the fence of a waiting_cli row, against what happens between the candidate read and the fence', () => {
    interface Race {
      id: string;
      what: string;
      epoch: number;
      mutate: (taskId: string, rowId: string) => Promise<unknown>;
    }
    const onTask = (taskId: string) => eq(schema.tasks.id, taskId);
    const onRow = (rowId: string) => eq(schema.taskSteps.id, rowId);
    const RACES: Race[] = [
      {
        id: 'WQ1',
        what: 'a pass records an unstarted run for the next wave',
        epoch: E,
        mutate: async (taskId, rowId) => {
          await seedRun(taskId, rowId, { createdAt: new Date() });
        },
      },
      {
        id: 'WQ2',
        what: 'a started run is recorded for the row',
        epoch: E,
        mutate: async (taskId, rowId) => {
          await seedRun(taskId, rowId, {
            mode: 'agent_mining',
            createdAt: new Date(),
            startedAt: new Date(),
          });
        },
      },
      {
        id: 'WQ3',
        what: 'a pass writes the row',
        epoch: E,
        mutate: (_t, rowId) =>
          db.update(schema.taskSteps).set({ updatedAt: new Date() }).where(onRow(rowId)),
      },
      {
        id: 'WQ4',
        what: 'the continuation finishes the step',
        epoch: E,
        mutate: (_t, rowId) =>
          db
            .update(schema.taskSteps)
            .set({ status: 'done', endedAt: new Date(), updatedAt: new Date() })
            .where(onRow(rowId)),
      },
      {
        id: 'WQ5',
        what: 'a Resume moves the epoch',
        epoch: E + 1,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ orchestrationEpoch: E + 1 })
            .where(onTask(taskId)),
      },
      {
        id: 'WQ6',
        what: 'the pointer moves to another step',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ currentStepId: OTHER }).where(onTask(taskId)),
      },
      {
        id: 'WQ7',
        what: 'the task is stamped',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ updatedAt: new Date() }).where(onTask(taskId)),
      },
      {
        id: 'WQ8',
        what: 'a Stop fails the task',
        epoch: E,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ status: 'failed', errorMessage: 'Stopped by user' })
            .where(onTask(taskId)),
      },
      {
        id: 'WQ9',
        what: 'the task is marked dead',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ deadAt: new Date() }).where(onTask(taskId)),
      },
    ];

    it.each(RACES)('$id: no bump and no enqueue when $what', async ({ mutate, epoch }) => {
      const { taskId, rowId } = await parkedOnCli();
      await endedRun(taskId, rowId);
      const { deps, advances, seen } = rig({
        queued: async () => {
          await mutate(taskId, rowId);
          return none();
        },
      });
      const redriven = await redriveStalledTasks(db, deps, { staleMs: STALE_MS });
      expect(seen.seam, 'the candidate was read and the race window was reached').toBe(1);
      expect(redriven, 'the fence refused').toBe(0);
      expect(advances, 'nothing was queued').toEqual([]);
      expect(await epochOf(taskId), 'no epoch bump of the sweep').toBe(epoch);
    });
  });

  describe('throttle and failure of a waiting_cli re-drive', () => {
    it('WF1: a second pass right after a re-drive does nothing', async () => {
      const { taskId, rowId } = await parkedOnCli();
      await endedRun(taskId, rowId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(advances, 'one advance in all').toHaveLength(1);
      expect(await epochOf(taskId), 'one bump in all').toBe(E + 1);
    });

    it('WF2: an enqueue that keeps failing hands the epoch back, and the next overdue pass re-drives', async () => {
      const { taskId, rowId } = await parkedOnCli();
      await endedRun(taskId, rowId);
      let refusing = true;
      const { deps, advances, seen } = rig({
        retryDelaysMs: [0, 0],
        enqueue: async () => {
          if (refusing) throw new Error('the queue refused the job');
        },
      });
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(seen.attempts, 'the sweep tried to queue the re-drive').toBeGreaterThanOrEqual(1);
      expect(await epochOf(taskId), 'the epoch is the one the sweep read').toBe(E);

      refusing = false;
      await db
        .update(schema.tasks)
        .set({ updatedAt: ago(OVERDUE) })
        .where(eq(schema.tasks.id, taskId));
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      expect(advances).toEqual([{ taskId, userId, stepId: S, round: ROUND, epoch: E + 1 }]);
    });
  });

  describe('the re-driven job of a waiting_cli row, run by the real handler', () => {
    it('WE1: resumes the step once and hands off; the continuation that turns up late, at the old epoch, is dropped', async () => {
      const { taskId, rowId } = await parkedOnCli(
        {},
        {
          detectOutput: {},
          formSchema: { title: S, fields: [] },
          formValues: {},
        },
      );
      await endedRun(taskId, rowId);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the parked row',
      ).resolves.toBe(1);
      const redrive = advances[0]!;
      expect(redrive).toEqual({ taskId, userId, stepId: S, round: ROUND, epoch: E + 1 });

      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { ...redrive }));
      expect(calls.apply, 'the re-driven job resumed the step: its apply ran once').toBe(1);
      const finished = (await state(taskId)).steps.find((step) => step.stepId === S);
      expect(finished?.status).toBe('done');
      const handoffs = h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);
      expect(handoffs, 'one hand-off, to the next step of the run list').toHaveLength(1);
      expect(handoffs[0]!.data).toMatchObject({ taskId, stepId: OTHER });

      // The continuation the lost add would have been, stamped with the epoch the sweep replaced.
      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: S, round: ROUND, epoch: E }),
      );
      expect(calls.apply, 'the old-epoch job was dropped: the step did not run again').toBe(1);
      expect(
        h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP),
        'and it handed nothing off',
      ).toHaveLength(1);
    });
  });
});
