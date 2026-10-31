import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { markModuleSchemaReady, markModuleSchemaUnready } from '../src/modules/schema-ready.js';
import { holdStepAdvance, processTaskJob } from '../src/queues/task-queue.js';
import {
  redriveStalledTasks,
  type StalledRedriveDeps,
  type TaskQueueOwed,
} from '../src/queues/stalled-redrive.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

// The stalled sweep and a park nothing drives (T385 item 1): a task whose current row is `pending`
// with `waiting_started_at` set (the runtime-slot, pause and module-schema parks) is re-driven once
// both its row heartbeat and its own stamp are older than the cutoff and the task queue owes it no
// job, by the same fence as every other re-drive. Real Postgres, fake queue deps, real clock offsets.

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('../src/sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/runtime-admission.js')>()),
  // The pool is full whenever a runtime step asks.
  runtimeAdmission: async () => ({
    decision: 'park',
    busyMb: 2048,
    budgetMb: 2048,
    myWeightMb: 512,
    position: 1,
    waiting: 1,
  }),
  releaseRuntimeReservation: async () => undefined,
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) {
      h.adds.push({ name, data, opts: opts ?? {} });
    }
  },
}));

const url = process.env.STALLED_PARKED_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/stalled_parked_test'))
  throw new Error('Use a dedicated stalled_parked_test database for the stalled parked tests');

const TYPE = 'fnf385_stalled_parked';
const S = '01-parked-step';
const OTHER = '02-other-step';
const NEXT = '03-next-step';
/** A step that needs the per-task runtime, so a full pool parks it on a slot. */
const RUNTIME = '04-runtime-step';
/** A module step, for the continuation a module's unready schema defers. */
const MODULE = `alpha-${randomBytes(3).toString('hex')}`;
const MODULE_STEP = `module.${MODULE}.x`;
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

const calls = { detect: 0, apply: 0 };
function stub(id: string, index: number, needsRuntime?: 'app'): StepDefinition {
  return {
    ...(needsRuntime ? { needsRuntime } : {}),
    metadata: {
      id,
      workflowType: 'workflow' as WorkflowType,
      index,
      title: id,
      description: 'stalled parked test stub',
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
    enqueue?: (advance: Advance) => Promise<void>;
    retryDelaysMs?: number[];
  } = {},
) {
  const advances: Advance[] = [];
  const seen = { seam: 0, attempts: 0, failTask: 0, start: 0 };
  const deps: StalledRedriveDeps = {
    enqueueAdvance: async (taskId, userId, stepId, round, epoch) => {
      seen.attempts++;
      const advance = { taskId, userId, stepId, round, epoch };
      await opts.enqueue?.(advance);
      advances.push(advance);
    },
    failTask: async () => {
      seen.failTask++;
      return true;
    },
    enqueueStart: async () => {
      seen.start++;
    },
    queuedTaskJobs: async () => {
      seen.seam++;
      return opts.queued ? await opts.queued() : none();
    },
    queuedInvocationIds: async () => new Set<string>(),
    redriveRetryDelaysMs: opts.retryDelaysMs ?? [],
  };
  return { deps, advances, seen };
}

describe.skipIf(!url)('the stalled sweep and a park nothing drives, on Postgres', () => {
  const EMAIL_INDEX = 'stalled-parked-test-user';
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
        title: 'stalled parked',
        status: 'running',
        orchestrationEpoch: E,
        currentStepId: S,
        currentRound: ROUND,
        runListSnapshot: [S, OTHER, NEXT, RUNTIME],
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
        status: 'pending',
        waitingStartedAt: ago(12 * MIN),
        statusMessage: 'Waiting for a free runtime slot',
        createdAt: ago(2 * OVERDUE),
        updatedAt: ago(OVERDUE),
        ...over,
      })
      .returning({ id: schema.taskSteps.id });
    return made!.id;
  };
  /** A task on a parked row, both stamps overdue unless the overrides say otherwise. */
  const parked = async (
    taskOver: Partial<typeof schema.tasks.$inferInsert> = {},
    rowOver: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const taskId = await seedTask(taskOver);
    const rowId = await seedRow(taskId, rowOver);
    return { taskId, rowId };
  };

  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const state = async (taskId: string) => ({
    task: plain((await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!),
    steps: plain(
      await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(asc(schema.taskSteps.stepId)),
    ),
    events: plain(
      await db
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.taskId, taskId))
        .orderBy(asc(schema.taskEvents.createdAt)),
    ),
  });
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
        emailEncrypted: 'stalled-parked-test@test.local',
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
        name: 'stalled-parked',
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
    stepRegistry.override(stub(RUNTIME, 4, 'app'));
    stepRegistry.override({
      ...stub(MODULE_STEP, 0),
      metadata: {
        id: MODULE_STEP,
        workflowType: `module.${MODULE}` as WorkflowType,
        index: 0,
        title: MODULE_STEP,
        description: 'the first step of a module run list',
        requiresCli: false,
      },
    } as StepDefinition);
    await db.insert(schema.modules).values({
      moduleId: MODULE,
      packageName: `@haive/module-${MODULE}`,
      name: MODULE,
      installedVersion: '1.0.0',
      deactivatedAt: null,
    });
  });

  beforeEach(async () => {
    h.adds.length = 0;
    calls.detect = calls.apply = 0;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    markModuleSchemaReady(MODULE);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, MODULE));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe('a park that is overdue and unqueued', () => {
    it('P1: is re-driven once, at the next epoch, and the sweep writes nothing to the row', async () => {
      const { taskId } = await parked();
      const before = await state(taskId);
      // A job queued for ANOTHER task, and a START for a third, hold nothing of this one.
      const { deps, advances, seen } = rig({
        queued: () => ({ steps: new Set([randomUUID()]), starts: new Set([randomUUID()]) }),
      });
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the overdue park',
      ).resolves.toBe(1);
      expect(seen.seam, 'the queue was read once').toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('P2: is re-driven at boot (staleMs 0) though its heartbeat is fresh, when no job exists', async () => {
      const { taskId } = await parked({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: 0 }),
        'boot took the park whose job is gone',
      ).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('P3 (control): a pending row with NO marker is re-driven today, so the seeds, deps and database drive a re-drive', async () => {
      const { taskId } = await parked({}, { waitingStartedAt: null, statusMessage: null });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });

    it('P16: is re-driven with no park copy on the row, since the marker and not the message makes it a park', async () => {
      const { taskId } = await parked({}, { statusMessage: null });
      const before = await state(taskId);
      const { deps, advances } = rig();
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(1);
      await expectRedriven(taskId, before, advances);
    });
  });

  describe('a park the sweep leaves alone', () => {
    interface Alone {
      id: string;
      why: string;
      seed: () => Promise<string>;
      queued?: (taskId: string) => TaskQueueOwed | null;
      staleMs?: number;
    }
    const statuses = [
      'waiting_user',
      'waiting_pr',
      'failed',
      'paused',
      'cancelled',
      'completed',
    ] as const;
    const ALONE: Alone[] = [
      {
        id: 'P4',
        why: 'its row heartbeat is fresh (a tick just ran)',
        seed: async () => (await parked({}, { updatedAt: ago(FRESH) })).taskId,
      },
      {
        id: 'P5',
        why: 'its own stamp is fresh',
        seed: async () => (await parked({ updatedAt: ago(FRESH) })).taskId,
      },
      {
        id: 'P6',
        why: 'the queue holds a job for the task',
        seed: async () => (await parked()).taskId,
        queued: (taskId) => ({ steps: new Set([taskId]), starts: new Set() }),
      },
      {
        id: 'P7',
        why: 'the queue holds a START for the task',
        seed: async () => (await parked()).taskId,
        queued: (taskId) => ({ steps: new Set(), starts: new Set([taskId]) }),
      },
      {
        id: 'P8',
        why: 'the task is dead',
        seed: async () => (await parked({ deadAt: ago(OVERDUE) })).taskId,
      },
      ...statuses.map((status, index) => ({
        id: `P9.${index + 1}`,
        why: `the task is ${status}, not running`,
        seed: async () => (await parked({ status })).taskId,
      })),
      {
        id: 'P10',
        why: 'the row is a parked FORM (waiting_form with a marker), not a parked step',
        seed: async () => (await parked({}, { status: 'waiting_form' })).taskId,
      },
      {
        id: 'P11',
        why: 'the parked row belongs to ANOTHER step than the one the task points at',
        seed: async () => {
          const taskId = await seedTask();
          // The row the pointer addresses is one no sweep clause takes (waiting_cli, no run to recover).
          await seedRow(taskId, { status: 'waiting_cli', waitingStartedAt: null });
          await seedRow(taskId, { stepId: OTHER, stepIndex: 2 });
          return taskId;
        },
      },
      {
        id: 'P12',
        why: 'the task queue cannot be read',
        seed: async () => (await parked()).taskId,
        queued: () => null,
      },
      {
        id: 'P13',
        why: 'boot finds its tick still queued',
        seed: async () =>
          (await parked({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) })).taskId,
        queued: (taskId) => ({ steps: new Set([taskId]), starts: new Set() }),
        staleMs: 0,
      },
      {
        id: 'P14',
        why: 'boot finds its START queued',
        seed: async () =>
          (await parked({ updatedAt: ago(5_000) }, { updatedAt: ago(5_000) })).taskId,
        queued: (taskId) => ({ steps: new Set(), starts: new Set([taskId]) }),
        staleMs: 0,
      },
    ];

    it.each(ALONE)('$id: takes nothing when $why', async ({ seed, queued, staleMs }) => {
      const taskId = await seed();
      const before = await state(taskId);
      const { deps, advances, seen } = rig(queued ? { queued: () => queued(taskId) } : {});
      await expect(redriveStalledTasks(db, deps, { staleMs: staleMs ?? STALE_MS })).resolves.toBe(
        0,
      );
      expect(advances, 'nothing was queued').toEqual([]);
      expect(seen).toMatchObject({ attempts: 0, failTask: 0, start: 0 });
      expect(await state(taskId), 'nothing was written').toEqual(before);
    });
  });

  describe('a step a pass of this process is on, whose job Redis lost', () => {
    it('P15: is left alone while the pass holds the step, and taken once the hold is released', async () => {
      const { taskId } = await parked();
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

  describe('the fence, against what happens between the candidate read and the fence', () => {
    interface Race {
      id: string;
      what: string;
      epoch: number;
      mutate: (taskId: string, rowId: string) => Promise<unknown>;
    }
    const onTask = (taskId: string) => eq(schema.tasks.id, taskId);
    const RACES: Race[] = [
      {
        id: 'P20',
        what: 'a tick refreshes the row heartbeat',
        epoch: E,
        mutate: (_t, rowId) =>
          db
            .update(schema.taskSteps)
            .set({ updatedAt: new Date() })
            .where(eq(schema.taskSteps.id, rowId)),
      },
      {
        id: 'P21',
        what: 'a worker claims the row',
        epoch: E,
        mutate: (_t, rowId) =>
          db
            .update(schema.taskSteps)
            .set({
              status: 'running',
              waitingStartedAt: null,
              startedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.taskSteps.id, rowId)),
      },
      {
        id: 'P22',
        what: 'a Retry moves the epoch',
        epoch: E + 1,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ orchestrationEpoch: E + 1 })
            .where(onTask(taskId)),
      },
      {
        id: 'P23',
        what: 'the pointer moves to another step',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ currentStepId: OTHER }).where(onTask(taskId)),
      },
      {
        id: 'P24',
        what: 'the pointer moves to another round',
        epoch: E,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ currentRound: ROUND + 1 })
            .where(onTask(taskId)),
      },
      {
        id: 'P25',
        what: 'the task is stamped',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ updatedAt: new Date() }).where(onTask(taskId)),
      },
      {
        id: 'P26',
        what: 'a Stop fails the task',
        epoch: E,
        mutate: (taskId) =>
          db
            .update(schema.tasks)
            .set({ status: 'failed', errorMessage: 'Stopped by user' })
            .where(onTask(taskId)),
      },
      {
        id: 'P27',
        what: 'the task is marked dead',
        epoch: E,
        mutate: (taskId) =>
          db.update(schema.tasks).set({ deadAt: new Date() }).where(onTask(taskId)),
      },
    ];

    it.each(RACES)('$id: no bump and no enqueue when $what', async ({ mutate, epoch }) => {
      const { taskId, rowId } = await parked();
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
    it('P30: a second pass right after a re-drive does nothing', async () => {
      const { taskId } = await parked();
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the first pass re-drove',
      ).resolves.toBe(1);
      await expect(redriveStalledTasks(db, deps, { staleMs: STALE_MS })).resolves.toBe(0);
      expect(advances, 'one advance in all').toHaveLength(1);
      expect(await epochOf(taskId), 'one bump in all').toBe(E + 1);
    });

    it('P31: an enqueue that keeps failing hands the epoch back, and the next overdue pass re-drives', async () => {
      const { taskId } = await parked();
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
    /** The sweep takes the park, the real handler runs the job it queued, then the job it replaced
     *  turns up at the old epoch. */
    const reParks = async (taskId: string, stepId: string) => {
      const parkedRow = (await state(taskId)).steps[0]!;
      const { deps, advances } = rig();
      await expect(
        redriveStalledTasks(db, deps, { staleMs: STALE_MS }),
        'the sweep took the park',
      ).resolves.toBe(1);
      const redrive = advances[0]!;
      expect(redrive).toEqual({ taskId, userId, stepId, round: ROUND, epoch: E + 1 });

      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { ...redrive }));

      const queued = h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);
      expect(queued, 'exactly one next tick, so exactly one chain').toHaveLength(1);
      expect(queued[0]!.data).toEqual({ taskId, userId, stepId, round: ROUND, epoch: E + 1 });
      expect(queued[0]!.opts.delay as number, 'the next tick is delayed').toBeGreaterThan(0);
      expect(
        queued[0]!.opts.deduplication,
        'a park tick carries no deduplication id: it is queued while the previous tick is still active',
      ).toBeUndefined();
      const ticked = (await state(taskId)).steps[0]!;
      expect(ticked.status).toBe('pending');
      expect(ticked.waitingStartedAt, 'the park marker is unchanged').toBe(
        parkedRow.waitingStartedAt,
      );
      expect(ms(ticked.updatedAt), 'the heartbeat is refreshed').toBeGreaterThan(
        ms(parkedRow.updatedAt),
      );
      expect(calls.apply, 'the held step did not run').toBe(0);

      // The job the park lost turns up again, still at the epoch the sweep read.
      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId, round: ROUND, epoch: E }),
      );
      expect(
        h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP),
        'the old-epoch job was dropped: no second tick',
      ).toHaveLength(1);
      expect((await state(taskId)).steps[0], 'and it wrote nothing').toEqual(ticked);
      expect(calls.apply).toBe(0);
    };

    it('P40: a pause park parks again as ONE delayed tick with the marker kept and the heartbeat refreshed, and the old-epoch job is dropped', async () => {
      const { taskId } = await parked({ pausedAt: ago(30 * MIN) });
      await reParks(taskId, S);
    });

    it('P42: a runtime-slot park (the pool is still full) does the same', async () => {
      const taskId = await seedTask({ currentStepId: RUNTIME });
      await seedRow(taskId, { stepId: RUNTIME, stepIndex: 4, title: RUNTIME });
      await reParks(taskId, RUNTIME);
    });

    it('P41: the deferral of a module step whose schema is not ready (a continuation) carries no deduplication id either', async () => {
      markModuleSchemaUnready(MODULE);
      const taskId = await seedTask({ currentStepId: MODULE_STEP, runListSnapshot: [MODULE_STEP] });
      await seedRow(taskId, {
        stepId: MODULE_STEP,
        title: MODULE_STEP,
        status: 'waiting_form',
        waitingStartedAt: null,
        statusMessage: null,
        formSchema: { title: 'x', fields: [] },
        formValues: { saved: 'yes' },
      });
      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, {
          taskId,
          userId,
          stepId: MODULE_STEP,
          round: ROUND,
          formValues: { answer: 'now' },
        }),
      );
      const deferred = h.adds.filter((add) => add.name === TASK_JOB_NAMES.ADVANCE_STEP);
      expect(deferred, 'the advance waits, once').toHaveLength(1);
      expect(deferred[0]!.opts.delay as number, 'and it is delayed').toBeGreaterThan(0);
      expect(
        deferred[0]!.opts.deduplication,
        'a continuation carries no deduplication id',
      ).toBeUndefined();
      expect(calls.apply, 'the module step did not run').toBe(0);
    });
  });
});
