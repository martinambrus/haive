import { randomUUID } from 'node:crypto';
import {
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions,
  type JobType,
  type QueueOptions,
} from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QUEUE_NAMES, createBullRedisConnection } from '@haive/shared';
import type { Database } from '@haive/database';
import { closeCliExecQueue, getCliExecQueue } from '../src/queues/cli-exec/_shared.js';
import { resumeStepIfLinked } from '../src/queues/cli-exec/resolvers.js';
import { reviveDeadTasks } from '../src/queues/dead-task-boot.js';
import { defaultDeps } from '../src/queues/stalled-redrive.js';
import {
  closeTaskQueue,
  enqueueAdvance,
  getTaskQueue,
  reconcileOrphanedSteps,
} from '../src/queues/task-queue.js';
import { closeRedis, getRedis, initRedis } from '../src/redis.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

// The advance job the recovery re-drives queue (T385 item 2): `enqueueAdvance(..., { deduplicate: true })`
// adds it with a BullMQ `deduplication` id, one per (task, step, round, epoch), so two re-drives of
// one epoch collapse while the first is live (waiting, delayed or active) and the id is free again
// once that job completed, failed or was removed. A plain custom jobId is NOT that: BullMQ swallows a
// later add while the first job is retained as completed. Park ticks, continuations and the forward
// hand-off pass no option, since a tick queues its successor while it is still active.
//
// The continuation a finished CLI run queues (`resumeStepIfLinked`) is checked here too, with no
// deduplication id but with the retries and backoff every other advance producer uses.
//
// Opt-in: needs ADVANCE_DEDUP_TEST_REDIS_URL, a Redis of its own (never the app's REDIS_URL). Every
// queue the code under test makes lives under a private key prefix, removed after each case.

const redisUrl = process.env.ADVANCE_DEDUP_TEST_REDIS_URL;
const hoisted = vi.hoisted(() => {
  const original = process.env.REDIS_URL;
  // Whatever the code under test reads from REDIS_URL, lazily, must reach this Redis and never the app's.
  if (process.env.ADVANCE_DEDUP_TEST_REDIS_URL) {
    process.env.REDIS_URL = process.env.ADVANCE_DEDUP_TEST_REDIS_URL;
  }
  return { prefix: `t385-dedup-${globalThis.crypto.randomUUID()}`, original };
});

// The three reads a continuation makes before it queues itself, answered without a database.
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      cliInvocations: { findFirst: async () => ({ supersededAt: null }) },
      taskSteps: { findFirst: async () => ({ stepId: '07-phase-2-implement', round: 2 }) },
      tasks: { findFirst: async () => ({ orchestrationEpoch: 5 }) },
    },
  }),
}));

vi.mock('bullmq', async (importOriginal) => {
  const real = await importOriginal<typeof import('bullmq')>();
  return {
    ...real,
    Queue: class extends real.Queue {
      constructor(name: string, opts?: QueueOptions) {
        super(name, { ...opts, prefix: hoisted.prefix } as QueueOptions);
      }
    },
  };
});

type AdvanceOptions = Parameters<typeof enqueueAdvance>[5] & { deduplicate?: boolean };
const DEDUP: AdvanceOptions = { deduplicate: true };
const ALL_STATES: JobType[] = [
  'waiting',
  'delayed',
  'active',
  'completed',
  'failed',
  'prioritized',
  'waiting-children',
];

interface Tuple {
  taskId: string;
  userId: string;
  stepId: string;
  round: number;
  epoch: number;
}
const tuple = (over: Partial<Tuple> = {}): Tuple => ({
  taskId: randomUUID(),
  userId: randomUUID(),
  stepId: '07-phase-2-implement',
  round: 2,
  epoch: 5,
  ...over,
});
const add = (t: Tuple, opts?: AdvanceOptions) =>
  enqueueAdvance(t.taskId, t.userId, t.stepId, t.round, t.epoch, opts);
const jobsOf = async (taskId: string) =>
  (await getTaskQueue().getJobs(ALL_STATES)).filter(
    (job) => (job.data as { taskId?: string }).taskId === taskId,
  );
const statesOf = async (taskId: string) =>
  (await Promise.all((await jobsOf(taskId)).map((job) => job.getState()))).sort();

async function waitFor(condition: () => Promise<boolean> | boolean, what: string, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A real BullMQ worker on the task queue, as the production one is built (RESP2 connection). */
function startWorker(processor: (job: Job) => Promise<unknown>) {
  const connection = createBullRedisConnection(redisUrl!);
  const worker = new Worker(QUEUE_NAMES.TASK, processor, {
    connection,
    prefix: hoisted.prefix,
    concurrency: 5,
  });
  return {
    stop: async () => {
      await worker.close();
      await connection.quit();
    },
  };
}

/** The deduplication ids the spied `Queue.add` saw, one per call. */
const dedupIds = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => (call[2] as JobsOptions | undefined)?.deduplication?.id);

/** Three ids for the same tuple, the same tuple, and another epoch: set, equal, and different. */
function expectOneIdPerTuple(ids: (string | undefined)[]) {
  const [first, again, other] = ids;
  expect(first, 'the re-drive is queued with a deduplication id').toEqual(expect.any(String));
  expect(first, 'the id is not empty').not.toBe('');
  expect(again, 'one tuple, one id').toBe(first);
  expect(other, 'another epoch, another id').toEqual(expect.any(String));
  expect(other, 'another epoch, another id').not.toBe(first);
}

describe.skipIf(!redisUrl)("the recovery re-drives' advance job id, on an isolated Redis", () => {
  beforeAll(async () => {
    initRedis(redisUrl!);
    expect(
      await getRedis().keys(`${hoisted.prefix}:*`),
      'the private key prefix starts empty',
    ).toEqual([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getTaskQueue().obliterate({ force: true });
    await getCliExecQueue().obliterate({ force: true });
    await closeTaskQueue();
    await closeCliExecQueue();
  });

  afterAll(async () => {
    expect(await getRedis().keys(`${hoisted.prefix}:*`), 'all test keys removed').toEqual([]);
    await closeRedis();
    if (hoisted.original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = hoisted.original;
  });

  describe('the deduplication option', () => {
    it('D1: two adds for one tuple while the first is waiting leave one job', async () => {
      const t = tuple();
      await add(t, DEDUP);
      await add(t, DEDUP);
      expect(await jobsOf(t.taskId), 'the second add collapsed onto the first').toHaveLength(1);
    });

    it('D2: two adds for one tuple while the first is delayed leave one job', async () => {
      const t = tuple();
      await add(t, { ...DEDUP, delayMs: 60_000 });
      await add(t, DEDUP);
      expect(await statesOf(t.taskId), 'one delayed job, no second').toEqual(['delayed']);
    });

    it('D3 (pin): another epoch, round, step or task gets its own job', async () => {
      const t = tuple();
      const other = tuple();
      await add(t, DEDUP);
      await add({ ...t, epoch: t.epoch + 1 }, DEDUP);
      await add({ ...t, round: t.round + 1 }, DEDUP);
      await add({ ...t, stepId: '08-phase-5-verify' }, DEDUP);
      await add({ ...t, taskId: other.taskId }, DEDUP);
      const jobs = await getTaskQueue().getJobs(ALL_STATES);
      expect(
        new Set(
          jobs.map((job) => {
            const d = job.data as Tuple;
            return [d.taskId, d.stepId, d.round, d.epoch].join('|');
          }),
        ).size,
        'five tuples, five jobs',
      ).toBe(5);
      expect(jobs).toHaveLength(5);
    });

    it('D4: a completed job frees the id, so the next add is a new job that runs (not swallowed like a plain jobId)', async () => {
      const t = tuple();
      const ran: string[] = [];
      await add(t, DEDUP);
      await add(t, DEDUP);
      expect(await jobsOf(t.taskId), 'the second add collapsed onto the first').toHaveLength(1);
      const first = (await jobsOf(t.taskId))[0]!;

      const worker = startWorker(async (job) => {
        ran.push(job.id!);
        return { ok: true };
      });
      try {
        await waitFor(async () => (await first.getState()) === 'completed', 'the first job');
        await add(t, DEDUP);
        await waitFor(() => ran.length === 2, 'the third add to run');
        expect(new Set(ran).size, 'two different jobs ran').toBe(2);
        expect(
          await jobsOf(t.taskId),
          'the completed job is retained beside the new one',
        ).toHaveLength(2);
      } finally {
        await worker.stop();
      }
    });

    it('D5: a failed job frees the id, so the next add is a new job that runs', async () => {
      const t = tuple();
      const ran: string[] = [];
      await add(t, DEDUP);
      await add(t, DEDUP);
      expect(await jobsOf(t.taskId), 'the second add collapsed onto the first').toHaveLength(1);
      const first = (await jobsOf(t.taskId))[0]!;

      // Three attempts with a 5 s backoff would take 15 s to exhaust; an unrecoverable error
      // reaches the same final `failed` state at once.
      const worker = startWorker(async (job) => {
        ran.push(job.id!);
        if (ran.length === 1) throw new UnrecoverableError('the first job fails for good');
        return { ok: true };
      });
      try {
        await waitFor(async () => (await first.getState()) === 'failed', 'the first job to fail');
        await add(t, DEDUP);
        await waitFor(() => ran.length === 2, 'the next add to run');
        expect(new Set(ran).size, 'two different jobs ran').toBe(2);
      } finally {
        await worker.stop();
      }
    });

    it('D6: a removed job frees the id, so the next add is a new job', async () => {
      const t = tuple();
      await add(t, { ...DEDUP, delayMs: 60_000 });
      await add(t, DEDUP);
      expect(await jobsOf(t.taskId), 'the second add collapsed onto the first').toHaveLength(1);
      const [first] = await jobsOf(t.taskId);
      await first!.remove();
      expect(await jobsOf(t.taskId)).toHaveLength(0);

      await add(t, DEDUP);
      const [next] = await jobsOf(t.taskId);
      expect(next, 'a new job exists').toBeDefined();
      expect(next!.id, 'and it is not the removed one').not.toBe(first!.id);
      expect(await next!.getState()).toBe('waiting');
    });

    it('D7 (premise): an add while the first job is ACTIVE collapses onto it, which is why a tick must not use the option', async () => {
      const t = tuple();
      let entered = false;
      let queuedSuccessor = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const worker = startWorker(async () => {
        if (!entered) {
          entered = true;
          await add(t, DEDUP);
          queuedSuccessor = true;
        }
        await gate;
      });
      try {
        await add(t, DEDUP);
        await waitFor(() => entered && queuedSuccessor, 'the active job to queue its successor');
        expect(await statesOf(t.taskId), 'the successor was swallowed by the active job').toEqual([
          'active',
        ]);
      } finally {
        release();
        await worker.stop();
      }
    });

    it('D9: the option adds a deduplication id to the job options and changes nothing else', async () => {
      const spy = vi.spyOn(getTaskQueue(), 'add').mockResolvedValue(undefined as never);
      const t = tuple();
      await add(t);
      await add(t, DEDUP);
      const [plain, deduplicated] = spy.mock.calls;
      expect(plain![0], 'the same job name').toBe(deduplicated![0]);
      expect(plain![1], 'the same payload').toEqual(deduplicated![1]);
      expect(plain![1]).toEqual({
        taskId: t.taskId,
        userId: t.userId,
        stepId: t.stepId,
        round: t.round,
        epoch: t.epoch,
      });
      const baseline = plain![2] as JobsOptions;
      expect(
        baseline,
        'without the option: no deduplication id, no custom job id',
      ).not.toHaveProperty('deduplication');
      expect(baseline).not.toHaveProperty('jobId');
      expect(
        deduplicated![2],
        'with the option: the same options plus a deduplication id (not a custom job id)',
      ).toEqual({ ...baseline, deduplication: { id: expect.any(String) } });
    });

    it('D8 (premise): a plain custom jobId is swallowed by a later add while the completed first job is retained', async () => {
      const t = tuple();
      const ran: string[] = [];
      const jobId = `plain-${t.taskId}`;
      const addPlain = () =>
        getTaskQueue().add('advance-step', t, { jobId, removeOnComplete: 100, removeOnFail: 100 });
      await addPlain();
      const worker = startWorker(async (job) => {
        ran.push(job.id!);
      });
      try {
        await waitFor(async () => {
          const [job] = await jobsOf(t.taskId);
          return job ? (await job.getState()) === 'completed' : false;
        }, 'the plain-id job to complete');
        await addPlain();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(ran, 'the second add never ran').toEqual([jobId]);
        expect(await jobsOf(t.taskId)).toHaveLength(1);
      } finally {
        await worker.stop();
      }
    });
  });

  describe('without the option (pins: park ticks, continuations and hand-offs are unchanged)', () => {
    it('N1: two adds for one tuple are two jobs', async () => {
      const t = tuple();
      await add(t);
      await add(t);
      expect(await jobsOf(t.taskId)).toHaveLength(2);
    });

    it('N2: two delayed adds (a park tick) for one tuple are two jobs', async () => {
      const t = tuple();
      await add(t, { delayMs: 60_000 });
      await add(t, { delayMs: 60_000 });
      expect(await statesOf(t.taskId)).toEqual(['delayed', 'delayed']);
    });

    it('N3: a tick that queues its successor while it is ACTIVE leaves the successor queued (the chain)', async () => {
      const t = tuple();
      let queuedSuccessor = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const worker = startWorker(async () => {
        if (!queuedSuccessor) {
          await add(t, { delayMs: 60_000 });
          queuedSuccessor = true;
        }
        await gate;
      });
      try {
        await add(t);
        await waitFor(() => queuedSuccessor, 'the active tick to queue its successor');
        expect(await statesOf(t.taskId), 'the active tick and its delayed successor').toEqual([
          'active',
          'delayed',
        ]);
      } finally {
        release();
        await worker.stop();
      }
    });
  });

  describe('who passes the option', () => {
    it('W1: the stalled sweep (defaultDeps.enqueueAdvance) passes one id per (task, step, round, epoch)', async () => {
      const spy = vi.spyOn(getTaskQueue(), 'add').mockResolvedValue(undefined as never);
      const t = tuple();
      await defaultDeps.enqueueAdvance(t.taskId, t.userId, t.stepId, t.round, t.epoch);
      await defaultDeps.enqueueAdvance(t.taskId, t.userId, t.stepId, t.round, t.epoch);
      await defaultDeps.enqueueAdvance(t.taskId, t.userId, t.stepId, t.round, t.epoch + 1);
      expectOneIdPerTuple(dedupIds(spy));
    });

    it('W2: boot reconcileOrphanedSteps with its default deps passes one id per (task, step, round, epoch)', async () => {
      const spy = vi.spyOn(getTaskQueue(), 'add').mockResolvedValue(undefined as never);
      const t = tuple();
      await reconcileOrphanedSteps(reconcileDb(t, t.epoch + 1));
      await reconcileOrphanedSteps(reconcileDb(t, t.epoch + 1));
      await reconcileOrphanedSteps(reconcileDb(t, t.epoch + 2));
      expect(spy, 'each pass re-drove the parked step once').toHaveBeenCalledTimes(3);
      expectOneIdPerTuple(dedupIds(spy));
    });

    it('W3: the dead-task boot with its default deps passes one id per (task, step, round, epoch)', async () => {
      const spy = vi.spyOn(getTaskQueue(), 'add').mockResolvedValue(undefined as never);
      const t = tuple({ stepId: DEAD_STEP });
      stepRegistry.override(deadStep());
      await reviveDeadTasks(deadTaskDb(t, t.epoch + 1));
      await reviveDeadTasks(deadTaskDb(t, t.epoch + 1));
      await reviveDeadTasks(deadTaskDb(t, t.epoch + 2));
      expect(spy, 'each pass revived the dead task once').toHaveBeenCalledTimes(3);
      expectOneIdPerTuple(dedupIds(spy));
    });
  });

  describe('the continuation a finished CLI run queues', () => {
    const continuation = (taskId: string) =>
      resumeStepIfLinked(
        {
          invocationId: randomUUID(),
          taskStepId: randomUUID(),
          taskId,
          userId: randomUUID(),
        } as never,
        true,
        null,
      );

    it('C1: is stored with retries and an exponential backoff, and with no deduplication id', async () => {
      const taskId = randomUUID();
      await continuation(taskId);
      const [job] = await jobsOf(taskId);
      expect(job, 'the continuation was queued').toBeDefined();
      expect(job!.data).toMatchObject({
        taskId,
        stepId: '07-phase-2-implement',
        round: 2,
        epoch: 5,
      });
      expect(job!.opts.attempts, 'it is retried like every other advance').toBe(3);
      expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
      expect(job!.opts, 'it shares its epoch with the pass that queued it').not.toHaveProperty(
        'deduplication',
      );
    });

    it('C2: a first attempt that throws is retried, where it used to be failed for good', async () => {
      const taskId = randomUUID();
      let threw = 0;
      const worker = startWorker(async () => {
        threw++;
        throw new Error('the first attempt failed');
      });
      try {
        await continuation(taskId);
        const [queued] = await jobsOf(taskId);
        await waitFor(
          async () => threw === 1 && (await queued!.getState()) !== 'active',
          'the first attempt to end',
        );
        const job = (await getTaskQueue().getJob(queued!.id!))!;
        expect(await job.getState(), 'a retry is scheduled, not a failure recorded').toBe(
          'delayed',
        );
        expect(job.attemptsMade, 'one attempt was made').toBe(1);
      } finally {
        await worker.stop();
      }
    });
  });
});

// --- Scripted databases for the two boot paths whose default deps are inline -------------------
// Each answers exactly the statements its one pass makes, so the pass reaches `enqueueAdvance` with
// the epoch the fence "returned" and the production default deps queue it through the spied Queue.add.

function tableNameOf(table: unknown): string {
  const sym = Object.getOwnPropertySymbols(table as object).find(
    (s) => s.description === 'drizzle:Name',
  );
  return sym ? String((table as Record<symbol, unknown>)[sym]) : '';
}

/** One `waiting_cli` step that IS the task's current step, with no run to end, whose epoch fence
 *  returns `fencedEpoch`. */
function reconcileDb(t: Tuple, fencedEpoch: number): Database {
  const stuck = {
    taskStepId: randomUUID(),
    taskId: t.taskId,
    stepId: t.stepId,
    round: t.round,
    userId: t.userId,
    epoch: t.epoch,
    currentStepId: t.stepId,
    currentRound: t.round,
  };
  let joinedReads = 0;
  const lockable = <T>(rows: T[]) =>
    Object.assign(Promise.resolve(rows), { for: async (_strength: string) => rows });
  const db = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const whereFn = (_cond: unknown) => ({
          for: async (_strength: string) => [],
          limit: (_n: number) => lockable([]),
          then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(
              tableNameOf(table) === 'cli_invocations' ? [] : joinedReads++ === 0 ? [stuck] : [],
            ).then(onOk, onErr),
        });
        return { innerJoin: (_t: unknown, _c: unknown) => ({ where: whereFn }), where: whereFn };
      },
    }),
    update: (table: unknown) => ({
      set: (_values: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          const done = Promise.resolve(undefined);
          return {
            then: (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              done.then(onOk, onErr),
            returning: async () => {
              const name = tableNameOf(table);
              if (name === 'tasks') return [{ epoch: fencedEpoch }];
              return name === 'task_steps' ? [{ id: stuck.taskStepId }] : [];
            },
          };
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return db as unknown as Database;
}

const DEAD_STEP = '07-phase-2-implement';
function deadStep(): StepDefinition {
  return {
    metadata: {
      id: DEAD_STEP,
      workflowType: 'workflow',
      index: 1,
      title: DEAD_STEP,
      description: 'advance dedup test stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return { title: DEAD_STEP, fields: [] };
    },
    async apply() {
      return {};
    },
  } as StepDefinition;
}

/** One dead task whose step is registered again, whose revival transaction returns `epoch` and an
 *  advance for its current step. */
function deadTaskDb(t: Tuple, epoch: number): Database {
  const task = {
    id: t.taskId,
    userId: t.userId,
    type: 'workflow',
    epoch: t.epoch,
    currentStepId: t.stepId,
    currentRound: t.round,
    runListSnapshot: [t.stepId],
    customSteps: null,
    deadAt: new Date(),
    deadReason: 'a step was missing',
  };
  return {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({ where: async (_cond: unknown) => [task] }),
    }),
    query: {
      taskTypeDefinitions: {
        findFirst: async (_opts?: unknown) => ({ runListStrategy: 'static', fixLoop: null }),
      },
    },
    transaction: async (_fn: unknown) => ({ epoch, job: { kind: 'advance', stepId: t.stepId } }),
  } as unknown as Database;
}
