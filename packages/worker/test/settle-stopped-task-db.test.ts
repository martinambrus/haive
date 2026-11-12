import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import * as stalled from '../src/queues/stalled-redrive.js';

const url = process.env.WORKER_SETTLE_STOPPED_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worker_settle_stopped_test'))
  throw new Error(
    'Use a dedicated worker_settle_stopped_test database for the settle stopped tests',
  );

// The worker's settle job for a task the api Stop failed, on Postgres. Every case drives the real
// processTaskJob. No docker, Redis or git is touched: each seam is a recorder (h.calls), the one
// docker call the job makes itself is a stubbed spawn, and the queue and Redis clients are fakes.
const h = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    db: undefined as unknown,
    /** When set, the db the job is handed instead of `db`. */
    wrap: undefined as unknown,
    calls,
    seen: (seam: string, taskId: string): void => {
      calls.push(`${seam}:${taskId}`);
    },
  };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.wrap ?? h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string) {
      h.calls.push(`queue.add:${name}`);
    }
  },
}));
vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (command: string, args: string[] = []) => {
      h.calls.push(`spawn ${[command, ...args].join(' ')}`);
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  };
});
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveTaskEmbedTarget: async () => ({ url: 'http://ollama.invalid', model: 'embed-test' }),
  releaseEmbedModelIfUnused: async (_db: unknown, opts: { excludeTaskId: string }) => {
    h.seen('releaseEmbedModelIfUnused', opts.excludeTaskId);
    return 'unloaded';
  },
}));
vi.mock('../src/sandbox/cli-sandbox-fence.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  supersedeTaskRuns: async (_db: unknown, taskId: string) => h.seen('supersedeTaskRuns', taskId),
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killCliSandboxesForTask: async (taskId: string) => {
    h.seen('killCliSandboxesForTask', taskId);
    return 0;
  },
  listCliSandboxesForTask: async (taskId: string) => {
    h.seen('listCliSandboxesForTask', taskId);
    return [];
  },
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncRefreshedAuthToUserVolumes: async (_db: unknown, taskId: string) =>
    h.seen('syncRefreshedAuthToUserVolumes', taskId),
  cleanupTaskAuthVolumes: async (taskId: string) => {
    h.seen('cleanupTaskAuthVolumes', taskId);
    return { removed: [], failed: [] };
  },
}));
vi.mock('../src/sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killTaskDdevRunners: async (taskId: string) => {
    h.seen('killTaskDdevRunners', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/app-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killTaskAppRunners: async (taskId: string) => {
    h.seen('killTaskAppRunners', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/ide-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killTaskIdeContainers: async (taskId: string) => {
    h.seen('killTaskIdeContainers', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/terminal-session-reaper.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reapAllSessionsForTask: async (_redis: unknown, _docker: unknown, taskId: string) => {
    h.seen('reapAllSessionsForTask', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unloadTaskOllamaCliModels: async (_db: unknown, taskId: string) =>
    h.seen('unloadTaskOllamaCliModels', taskId),
}));
vi.mock('../src/repo/worktree-remove.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  removeTaskWorktree: async (_db: unknown, taskId: string) => {
    h.seen('removeTaskWorktree', taskId);
    return { removed: false, worktreePath: null, method: null, branch: null, branchDeleted: false };
  },
}));
vi.mock('../src/repo/scratch-workspace.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cleanupTaskScratchWorkspace: async (_db: unknown, taskId: string) => {
    h.seen('cleanupTaskScratchWorkspace', taskId);
    return false;
  },
}));
vi.mock('../src/project-state/set-aside.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncAfterTaskEnd: async (_db: unknown, taskId: string) => h.seen('resyncAfterTaskEnd', taskId),
}));
vi.mock('../src/step-engine/left-open-merge.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordLeftOpenMerges: async (_db: unknown, taskId: string) =>
    h.seen('recordLeftOpenMerges', taskId),
}));
vi.mock('../src/step-engine/merge-dir-claim.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  releaseTaskMergeClaims: async (_db: unknown, taskId: string) =>
    h.seen('releaseTaskMergeClaims', taskId),
}));
vi.mock('../src/step-engine/steps/plan/01-plan-merge.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discardPlanMerge: async (_db: unknown, taskId: string) => h.seen('discardPlanMerge', taskId),
}));
vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileKbAuthorEntryOnTaskEnd: async (_db: unknown, taskId: string, reason: string) =>
    h.seen(`reconcileKbAuthorEntryOnTaskEnd(${reason})`, taskId),
}));

type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type Outcome = { ok: true } | { ok: false; error: unknown };

/** The stamp the Stop wrote on tasks.completed_at, a whole millisecond. */
const FAILED_AT = new Date('2026-01-16T09:30:00.123Z');
const T0 = new Date('2026-01-15T10:00:00.000Z');
/** The job name as the api queues it; the api checks pin the constant itself. */
const SETTLE_STOPPED = 'settle-stopped-task';
const EPOCH = 5;
const BLIND_INDEX = 'worker-settle-stopped-test-user';
const NO_SUCH_DIR = path.join(os.tmpdir(), 'worker-settle-stopped-test-no-such-dir');
const TEST_TIMEOUT = 30_000;

/** The seams a settle of a failed task reaches, as `<seam>` without the task id. */
const SETTLES = [
  'containerCleanup',
  'syncRefreshedAuthToUserVolumes',
  'cleanupTaskAuthVolumes',
  'reapAllSessionsForTask',
  'reconcileKbAuthorEntryOnTaskEnd(failed)',
  'resyncAfterTaskEnd',
  'unloadTaskOllamaCliModels',
  'releaseEmbedModelIfUnused',
] as const;
/** What Retry keeps and the settle must leave alone, plus every other member of a teardown. */
const NEVER = [
  'removeTaskWorktree',
  'killTaskDdevRunners',
  'killTaskAppRunners',
  'killTaskIdeContainers',
  'supersedeTaskRuns',
  'killCliSandboxesForTask',
  'cleanupTaskScratchWorkspace',
  'recordLeftOpenMerges',
  'releaseTaskMergeClaims',
  'discardPlanMerge',
  'queue.add',
] as const;

const outcomeOf = (run: Promise<unknown>): Promise<Outcome> =>
  run.then(
    (): Outcome => ({ ok: true }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
const describeOutcome = (o: Outcome): string =>
  o.ok ? 'resolved' : `rejected: ${String(o.error)}`;

describe.skipIf(!url)('the worker settle job for a task the api Stop failed, on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;

  const settleJob = (data: Record<string, unknown>) =>
    ({
      id: randomUUID(),
      name: SETTLE_STOPPED,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];
  const payloadFor = (taskId: string, failedAt: Date | string = FAILED_AT) => ({
    taskId,
    userId,
    failedAt: failedAt instanceof Date ? failedAt.toISOString() : failedAt,
  });
  const run = (data: Record<string, unknown>) => outcomeOf(processTaskJob(settleJob(data)));
  const callsFor = (taskId: string) =>
    h.calls.filter((c) => c.endsWith(`:${taskId}`)).map((c) => c.slice(0, -taskId.length - 1));
  const touched = (taskId: string, seams: readonly string[]) =>
    callsFor(taskId).filter((c) => seams.includes(c));

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    setContainerCleanupRunner(async (_db, taskId) => {
      h.seen('containerCleanup', taskId);
      return 0;
    });
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'worker-settle-stopped-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
    const [repository] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'worker-settle-stopped',
        source: 'local_path',
        localPath: NO_SUCH_DIR,
        storagePath: NO_SUCH_DIR,
        status: 'ready',
      })
      .returning({ id: schema.repositories.id });
    repositoryId = repository!.id;
  });

  beforeEach(async () => {
    h.calls.length = 0;
    h.wrap = undefined;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    h.wrap = undefined;
    setContainerCleanupRunner(null);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  /** A task with a step and a stopped run, as a Stop leaves it. */
  const seedTask = async (
    status: TaskStatus,
    over: Partial<typeof schema.tasks.$inferInsert> = {},
  ) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'workflow',
        title: 'worker settle stopped',
        status,
        currentStepId: '07-phase-2-implement',
        orchestrationEpoch: EPOCH,
        completedAt: status === 'running' ? null : FAILED_AT,
        createdAt: T0,
        updatedAt: T0,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    const taskId = task!.id;
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: '07-phase-2-implement',
        stepIndex: 7,
        title: 'implement',
        status: status === 'running' ? 'running' : 'failed',
        startedAt: T0,
        endedAt: status === 'running' ? null : T0,
        createdAt: T0,
        updatedAt: T0,
      })
      .returning({ id: schema.taskSteps.id });
    await db.insert(schema.cliInvocations).values({
      taskId,
      taskStepId: step!.id,
      mode: 'cli',
      prompt: 'p',
      startedAt: T0,
      endedAt: status === 'running' ? null : T0,
    });
    await db.insert(schema.taskEvents).values({
      taskId,
      eventType: 'task.stopped',
      payload: {},
    });
    return taskId;
  };

  /** Every row of the task in the three tables the job must never write, and its events. */
  const snapshot = async (taskId: string) =>
    JSON.stringify({
      task: await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }),
      steps: await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(asc(schema.taskSteps.id)),
      runs: await db
        .select()
        .from(schema.cliInvocations)
        .where(eq(schema.cliInvocations.taskId, taskId))
        .orderBy(asc(schema.cliInvocations.id)),
      events: await db
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.taskId, taskId))
        .orderBy(asc(schema.taskEvents.id)),
    });

  /** The job did nothing: it answered, started no member of a settle and left every row as it was. */
  const expectNoop = async (taskId: string, before: string, outcome: Outcome) => {
    expect(describeOutcome(outcome)).toBe('resolved');
    expect(callsFor(taskId), 'seams reached').toEqual([]);
    expect(h.calls.filter((c) => c.startsWith('spawn ') || c.startsWith('queue.add'))).toEqual([]);
    expect(await snapshot(taskId)).toBe(before);
  };

  it(
    'W1: a failed task whose completed_at is the stamp is settled and nothing else is touched',
    async () => {
      const taskId = await seedTask('failed');
      const before = await snapshot(taskId);

      const outcome = await run(payloadFor(taskId));

      expect(describeOutcome(outcome)).toBe('resolved');
      const seams = callsFor(taskId);
      for (const seam of SETTLES)
        expect(
          seams.filter((s) => s === seam),
          `calls of ${seam}`,
        ).toHaveLength(1);
      expect(touched(taskId, NEVER), 'seams Retry depends on').toEqual([]);
      expect(
        h.calls.filter((c) => c.startsWith('spawn ') && !c.startsWith('spawn docker ')),
      ).toEqual([]);
      expect(await snapshot(taskId)).toBe(before);
      const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
      expect(task?.status).toBe('failed');
      expect(task?.completedAt?.getTime()).toBe(FAILED_AT.getTime());
    },
    TEST_TIMEOUT,
  );

  describe('W2: a task that is running again is left alone', () => {
    it.each([
      ['Retry at the same epoch', EPOCH],
      ['Retry at a bumped epoch', EPOCH + 1],
    ])('W2: %s', async (_name, epoch) => {
      const taskId = await seedTask('running', { orchestrationEpoch: epoch });
      const before = await snapshot(taskId);

      await expectNoop(taskId, before, await run(payloadFor(taskId)));

      const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
      expect(task?.status).toBe('running');
    });

    it('W2: running with a completed_at equal to the stamp is still left alone', async () => {
      const taskId = await seedTask('running', { completedAt: FAILED_AT });
      const before = await snapshot(taskId);

      await expectNoop(taskId, before, await run(payloadFor(taskId)));
    });
  });

  it.each([1, -1])(
    'W3: a failed task whose completed_at differs from the stamp by %i ms is left alone',
    async (delta) => {
      const taskId = await seedTask('failed', {
        completedAt: new Date(FAILED_AT.getTime() + delta),
      });
      const before = await snapshot(taskId);

      await expectNoop(taskId, before, await run(payloadFor(taskId)));
    },
  );

  describe('W4: a task that ended another way, or is gone, is left alone', () => {
    it.each(['cancelled', 'completed'] as const)('W4: a %s task', async (status) => {
      const taskId = await seedTask(status);
      const before = await snapshot(taskId);

      await expectNoop(taskId, before, await run(payloadFor(taskId)));
    });

    it('W4: a task that does not exist', async () => {
      const taskId = randomUUID();

      const outcome = await run(payloadFor(taskId));

      expect(describeOutcome(outcome)).toBe('resolved');
      expect(callsFor(taskId)).toEqual([]);
    });
  });

  it(
    'W5: a database error in the job is rethrown and does not fail a running task',
    async () => {
      const taskId = await seedTask('running');
      const before = await snapshot(taskId);
      const injected = new Error('injected first access failure');
      let armed = true;
      const guarded = new Set<PropertyKey>(['query', 'select', 'execute', 'transaction']);
      h.wrap = new Proxy(db, {
        get(target, prop, receiver) {
          if (armed && guarded.has(prop)) {
            armed = false;
            throw injected;
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const outcome = await run(payloadFor(taskId));
      h.wrap = undefined;

      expect(armed, 'the job reached the database').toBe(false);
      expect(describeOutcome(outcome)).toBe(`rejected: ${String(injected)}`);
      expect(await snapshot(taskId)).toBe(before);
      const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
      expect(task?.status).toBe('running');
    },
    TEST_TIMEOUT,
  );

  describe('W6: the same job twice', () => {
    it(
      'W6: in sequence',
      async () => {
        const taskId = await seedTask('failed');
        const before = await snapshot(taskId);

        const first = await run(payloadFor(taskId));
        const second = await run(payloadFor(taskId));

        expect(describeOutcome(first)).toBe('resolved');
        expect(describeOutcome(second)).toBe('resolved');
        expect(touched(taskId, SETTLES).length).toBeGreaterThanOrEqual(SETTLES.length);
        expect(touched(taskId, NEVER)).toEqual([]);
        expect(await snapshot(taskId)).toBe(before);
      },
      TEST_TIMEOUT,
    );

    it(
      'W6: in parallel, without a deadlock',
      async () => {
        const taskId = await seedTask('failed');
        const before = await snapshot(taskId);

        const [first, second] = await Promise.all([
          run(payloadFor(taskId)),
          run(payloadFor(taskId)),
        ]);

        expect(describeOutcome(first)).toBe('resolved');
        expect(describeOutcome(second)).toBe('resolved');
        expect(touched(taskId, SETTLES).length).toBeGreaterThanOrEqual(SETTLES.length);
        expect(touched(taskId, NEVER)).toEqual([]);
        expect(await snapshot(taskId)).toBe(before);
      },
      TEST_TIMEOUT,
    );
  });

  describe('W7: a malformed payload is left alone', () => {
    it.each([
      ['no failedAt', (taskId: string) => ({ taskId, userId })],
      [
        'a failedAt that is not a date',
        (taskId: string) => ({ taskId, userId, failedAt: 'garbage' }),
      ],
      ['an empty failedAt', (taskId: string) => ({ taskId, userId, failedAt: '' })],
      ['a null failedAt', (taskId: string) => ({ taskId, userId, failedAt: null })],
    ])('W7: %s', async (_name, data) => {
      const taskId = await seedTask('failed');
      const before = await snapshot(taskId);

      await expectNoop(taskId, before, await run(data(taskId)));

      const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
      expect(task?.status).toBe('failed');
    });
  });

  describe('lost Stop settlement recovery', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
    afterEach(() => vi.useRealTimers());
    it('recovers a Cancel that never reached Redis using the existing finish marker', async () => {
      const taskId = await seedTask('cancelled');
      await db
        .insert(schema.taskEvents)
        .values({ taskId, eventType: 'task.cancelled', createdAt: new Date(Date.now() - 600_000) });
      const enqueueCancel = vi.fn(async () => undefined);
      const deps = { enqueueCancel, queuedCancelTaskIds: async () => new Set<string>() };
      expect(await stalled.redriveCancelledTasks(db, deps, { staleMs: 300_000 })).toBe(1);
      expect(enqueueCancel).toHaveBeenCalledWith(taskId, userId);
      await db.insert(schema.taskEvents).values({ taskId, eventType: 'task.cancel_finished' });
      expect(await stalled.redriveCancelledTasks(db, deps, { staleMs: 300_000 })).toBe(0);
    });
    const request = async (taskId: string, failedAt = FAILED_AT) => {
      await db.insert(schema.taskEvents).values({
        taskId,
        eventType: 'task.stop_settle_requested',
        payload: { failedAt: failedAt.toISOString() },
        createdAt: T0,
      });
    };
    const sweep = async (live = new Set<string>(), batchSize = 2) => {
      const queued: Record<string, unknown>[] = [];
      const count = await stalled.redriveStoppedTasks(
        db,
        {
          enqueueStopSettle: async (taskId: string, userId: string, failedAt: string) => {
            queued.push({ taskId, userId, failedAt });
          },
          queuedStoppedTaskIds: async () => live,
        },
        { staleMs: 300_000, batchSize },
      );
      return { count, queued };
    };

    it('queues a never-enqueued Stop once and throttles the next tick', async () => {
      const taskId = await seedTask('failed');
      await request(taskId);
      expect(await sweep()).toEqual({ count: 1, queued: [payloadFor(taskId)] });
      expect(await sweep()).toEqual({ count: 0, queued: [] });
    });

    it('requeues an exhausted settlement and a settled failure stays out of the sweep', async () => {
      const taskId = await seedTask('failed');
      await request(taskId);
      // Failed/completed queue history is absent from the live-job snapshot.
      expect((await sweep()).count).toBe(1);
      expect(describeOutcome(await run(payloadFor(taskId)))).toBe('resolved');
      await db
        .update(schema.taskEvents)
        .set({ createdAt: T0 })
        .where(eq(schema.taskEvents.eventType, 'task.stop_settle_redriven'));
      expect(await sweep()).toEqual({ count: 0, queued: [] });
      const events = await db.query.taskEvents.findMany({
        where: eq(schema.taskEvents.taskId, taskId),
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          eventType: 'task.stop_settle_finished',
          payload: { failedAt: FAILED_AT.toISOString() },
        }),
      );
    });

    it('leaves a resumed task and a later failure alone', async () => {
      const taskId = await seedTask('running');
      await request(taskId);
      expect((await sweep()).count).toBe(0);
      await db
        .update(schema.tasks)
        .set({ status: 'failed', completedAt: new Date(FAILED_AT.getTime() + 1) })
        .where(eq(schema.tasks.id, taskId));
      expect((await sweep()).count).toBe(0);
    });

    it('leaves a live settlement to its job', async () => {
      const taskId = await seedTask('failed');
      await request(taskId);
      expect(await sweep(new Set([taskId]))).toEqual({ count: 0, queued: [] });
    });

    it('leaves a just-issued Stop alone and bounds each batch', async () => {
      const fresh = await seedTask('failed', { completedAt: new Date() });
      await request(fresh, new Date());
      for (let i = 0; i < 3; i++) await request(await seedTask('failed'));
      const result = await sweep(new Set(), 2);
      expect(result.count).toBe(2);
      expect(result.queued.map((p) => p.taskId)).not.toContain(fresh);
    });

    it('allows the original and recovered settlements to finish together safely', async () => {
      const taskId = await seedTask('failed');
      await request(taskId);
      const outcomes = await Promise.all([run(payloadFor(taskId)), run(payloadFor(taskId))]);
      expect(outcomes.map(describeOutcome)).toEqual(['resolved', 'resolved']);
      expect((await sweep()).count).toBe(0);
      expect(touched(taskId, NEVER)).toEqual([]);
    });
  });
});
