import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';
import { TASK_JOB_NAMES } from '@haive/shared';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';

const url = process.env.WORKER_TASK_CANCEL_GUARD_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worker_task_cancel_guard_test'))
  throw new Error(
    'Use a dedicated worker_task_cancel_guard_test database for the worker task cancel guard tests',
  );

// The worker's CANCEL job beside the writers that can end a task first.
//
// A CANCEL that lands after a completion must leave the task completed and tear nothing down: the
// 'cancelled' teardown removes the task's worktree and deletes its env template. A task the api
// already cancelled keeps its completed_at and epoch, but the job still ends the step rows opened
// after the api's cancel, writes the task.cancelled event the stalled re-drive spaces its retries
// on, and runs the teardown. A failed task stays cancellable.
//
// Every case drives the real processTaskJob. No docker, Redis or git is touched: each teardown seam
// is replaced by a recorder (h.calls), the one docker call the job makes itself (the label sweep in
// task-queue.ts) is a stubbed spawn, and the queue and Redis clients are fakes.
const h = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    db: undefined as unknown,
    /** In call order: every teardown seam the job reached (`<seam>:<task id>`), child process it started and job it queued. */
    calls,
    seen: (seam: string, taskId: string): void => {
      calls.push(`${seam}:${taskId}`);
    },
  };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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
    // No sandbox of the task is left, so the teardown goes on to release its claims and finish.
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
  reconcileKbAuthorEntryOnTaskEnd: async (_db: unknown, taskId: string) =>
    h.seen('reconcileKbAuthorEntryOnTaskEnd', taskId),
}));

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Lock = (tx: Tx) => PromiseLike<unknown>;
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type TaskStatus = (typeof schema.tasks.$inferSelect)['status'];
type StepStatus = (typeof schema.taskSteps.$inferSelect)['status'];

/** The seeded rows were last written then; every cancel stamps a later time. */
const T0 = new Date('2026-01-15T10:00:00.000Z');
/** The completion time a peer commits in the race cases, apart from any time the job could stamp. */
const COMPLETED_AT = new Date('2026-01-16T09:30:00.000Z');
const EPOCH = 5;
const CANCELLED = 'Task cancelled';
const BLIND_INDEX = 'worker-task-cancel-guard-test-user';
/** A path nothing creates, so even a seam that escaped its recorder would find no repository on disk. */
const NO_SUCH_DIR = path.join(os.tmpdir(), 'worker-task-cancel-guard-test-no-such-dir');
const BLOCKED_WITHIN_MS = 10_000;
const SEED_ATTEMPTS = 10;
const TEST_TIMEOUT = 30_000;

// task_steps.id is a random uuid. W7 seeds step rows A (lower id) and B (higher id), inserted B then
// A, with step ids that make every scan order (physical, task_id index, the unique task/step/round
// index) reach B first, so the case does not depend on where Postgres happens to place the rows.
const A = { id: '00000000-0000-4000-8000-0000000000a1', stepId: 'step-b', stepIndex: 2 } as const;
const B = { id: '00000000-0000-4000-8000-0000000000b1', stepId: 'step-a', stepIndex: 1 } as const;

/** What a cancel runs once no sandbox of the task is left, as the job runs it today. */
const TEARDOWN = [
  'supersedeTaskRuns',
  'containerCleanup',
  'killTaskDdevRunners',
  'killTaskAppRunners',
  'killTaskIdeContainers',
  'syncRefreshedAuthToUserVolumes',
  'cleanupTaskAuthVolumes',
  'reapAllSessionsForTask',
  'removeTaskWorktree',
  'killCliSandboxesForTask',
  'listCliSandboxesForTask',
  'recordLeftOpenMerges',
  'releaseTaskMergeClaims',
  'discardPlanMerge',
  'resyncAfterTaskEnd',
  'cleanupTaskScratchWorkspace',
  'unloadTaskOllamaCliModels',
  'reconcileKbAuthorEntryOnTaskEnd',
] as const;

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string => {
  if (hasPgCode(error, '40P01')) return 'deadlock detected (40P01)';
  if (hasPgCode(error, '23503')) return `foreign key violation (23503): ${String(error)}`;
  return String(error);
};

const describeOutcome = (outcome: Outcome<unknown>): string =>
  outcome.ok ? 'resolved' : `rejected: ${describeError(outcome.error)}`;

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

/** A claim's fence read of the task row, taken after the claim flipped its step row. */
const readTaskRowShared =
  (taskId: string): Lock =>
  (tx) =>
    tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .for('share');

/** What a pass writes when it completes the task. */
const completeTask =
  (taskId: string): Lock =>
  (tx) =>
    tx
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: COMPLETED_AT, updatedAt: COMPLETED_AT })
      .where(eq(schema.tasks.id, taskId));

describe.skipIf(!url)(
  'the worker CANCEL job beside the writers that can end a task, on Postgres',
  () => {
    let db: Database;
    let peer: Database;
    let userId: string;
    let repositoryId: string;

    const cancelJob = (taskId: string) =>
      ({
        id: randomUUID(),
        name: TASK_JOB_NAMES.CANCEL,
        data: { taskId, userId },
        timestamp: Date.now(),
        moveToDelayed: async () => undefined,
      }) as unknown as Parameters<typeof processTaskJob>[0];
    const runCancel = (taskId: string) => processTaskJob(cancelJob(taskId));

    beforeAll(async () => {
      db = createDatabase(url as string);
      peer = createDatabase(url as string);
      h.db = db;
      setContainerCleanupRunner(async (_db, taskId) => {
        h.seen('containerCleanup', taskId);
        return 0;
      });
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: 'worker-task-cancel-guard-test@test.local',
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
          name: 'worker-task-cancel-guard',
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
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    });

    afterEach(() => {
      // The one process the job starts itself is the docker label sweep, answered by the stub. Anything
      // else (git, another tool) means a teardown path escaped its recorder.
      const stray = h.calls.filter(
        (call) => call.startsWith('spawn ') && !call.startsWith('spawn docker '),
      );
      expect(stray, 'child processes the job asked for besides docker').toEqual([]);
    });

    afterAll(async () => {
      setContainerCleanupRunner(null);
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
      await db.delete(schema.repositories).where(eq(schema.repositories.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.$client.end({ timeout: 5 });
      await peer.$client.end({ timeout: 5 });
    });

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
          title: 'worker task cancel guard',
          status,
          orchestrationEpoch: EPOCH,
          createdAt: T0,
          updatedAt: T0,
          ...over,
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };

    const seedStep = async (
      taskId: string,
      stepId: string,
      stepIndex: number,
      status: StepStatus,
      over: Partial<typeof schema.taskSteps.$inferInsert> = {},
    ) => {
      await db.insert(schema.taskSteps).values({
        taskId,
        stepId,
        stepIndex,
        title: stepId,
        status,
        startedAt: status === 'pending' ? null : T0,
        endedAt: status === 'done' ? T0 : null,
        createdAt: T0,
        updatedAt: T0,
        ...over,
      });
    };

    /** Rows A and B, inserted B then A. Postgres may place a new row on an earlier page than the row
     *  inserted before it, so a pair that landed A first is removed and inserted again until a scan
     *  reaches B first. */
    const seedAB = async (taskId: string, b: StepStatus, a: StepStatus) => {
      const row = (r: typeof A | typeof B, status: StepStatus) =>
        seedStep(taskId, r.stepId, r.stepIndex, status, { id: r.id });
      for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt++) {
        await db.delete(schema.taskSteps).where(inArray(schema.taskSteps.id, [A.id, B.id]));
        await row(B, b);
        await row(A, a);
        const scan = await db.execute<{ id: string }>(
          sql`select id from task_steps where task_id = ${taskId} order by ctid`,
        );
        if (scan.map((r) => r.id).join() === [B.id, A.id].join()) return;
      }
      throw new Error('test setup: no scan order reached B before A');
    };

    const taskView = async (taskId: string) => {
      const task = (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }))!;
      return {
        status: task.status,
        completedAt: task.completedAt,
        updatedAt: task.updatedAt,
        orchestrationEpoch: task.orchestrationEpoch,
      };
    };
    const stepsOf = (taskId: string) =>
      db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(asc(schema.taskSteps.stepIndex));
    const eventsOf = (taskId: string) =>
      db
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.taskId, taskId))
        .orderBy(asc(schema.taskEvents.createdAt));
    const eventsOfType = async (taskId: string, eventType: string) =>
      (await eventsOf(taskId)).filter((event) => event.eventType === eventType);
    const msOf = (date: Date | null | undefined) => date?.getTime() ?? 0;

    /** The seams the job reached for the task, in call order. */
    const seamsOf = (taskId: string) =>
      h.calls
        .filter((call) => call.endsWith(`:${taskId}`))
        .map((call) => call.slice(0, -taskId.length - 1));

    const expectTeardownRan = (taskId: string) =>
      expect
        .soft(seamsOf(taskId), 'teardown seams the job reached')
        .toEqual(expect.arrayContaining([...TEARDOWN]));

    /** The open step rows the job had to end: failed with the cancel reason, ended after the seeded time. */
    const expectEndedOpenStepRows = async (taskId: string, stepIds: string[]) => {
      const steps = await stepsOf(taskId);
      for (const stepId of stepIds) {
        const step = steps.find((s) => s.stepId === stepId);
        expect.soft(step, `step row ${stepId}`).toMatchObject({
          status: 'failed',
          errorMessage: CANCELLED,
        });
        expect
          .soft(msOf(step?.endedAt), `ended_at of ${stepId} after the seeded time`)
          .toBeGreaterThan(msOf(T0));
      }
    };

    /** The peer takes `first`; once the job is blocked on it, `whileBlocked` is asked, then the peer
     *  takes `second` (if any) and commits. A job that never waits for the peer fails the case. */
    async function interleave<T>(
      taskId: string,
      { first, second }: { first: Lock; second?: Lock },
      whileBlocked: () => Promise<T>,
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
          await second?.(tx);
        }),
      );
      await Promise.race([holding, peerRun]);
      if (!holdsFirst) {
        const early = await peerRun;
        throw new Error(
          `the peer ended before holding its first lock: ${early.ok ? 'no error' : describeError(early.error)}`,
        );
      }

      let jobEnded = false;
      const job = settle(runCancel(taskId));
      void job.then(() => (jobEnded = true));

      let observed: T | undefined;
      try {
        const deadline = Date.now() + BLOCKED_WITHIN_MS;
        for (;;) {
          if (jobEnded) {
            const early = await job;
            throw new Error(
              `the CANCEL job ended without waiting for the peer: ${describeOutcome(early)}`,
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
              `the CANCEL job was not blocked by the peer within ${BLOCKED_WITHIN_MS} ms`,
            );
          }
          await sleep(20);
        }
        observed = await whileBlocked();
      } finally {
        proceed();
        await Promise.all([peerRun, job]);
      }

      const [peerOutcome, jobOutcome] = await Promise.all([peerRun, job]);
      return {
        failures: [
          ...(peerOutcome.ok ? [] : [`peer: ${describeError(peerOutcome.error)}`]),
          ...(jobOutcome.ok ? [] : [`CANCEL job: ${describeError(jobOutcome.error)}`]),
        ],
        observed: observed as T,
      };
    }

    /** True when someone holds the task row right now: a NOWAIT lock on it from a third connection is refused. */
    const taskRowHeld = (taskId: string): Promise<boolean> =>
      db
        .transaction((tx) =>
          tx
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(eq(schema.tasks.id, taskId))
            .for('no key update', { noWait: true }),
        )
        .then(
          () => false,
          (error: unknown) => {
            if (!isLockNotAvailable(error)) throw error;
            return true;
          },
        );

    const RUNNING = 'step-running';
    const PENDING = 'step-pending';
    const DONE = 'step-done';

    /** A task with a running, a pending and a done step row, cancelled by the job. */
    async function cancelsAnOpenTask(
      status: TaskStatus,
      over: Partial<typeof schema.tasks.$inferInsert>,
    ) {
      const taskId = await seedTask(status, over);
      await seedStep(taskId, RUNNING, 1, 'running');
      await seedStep(taskId, PENDING, 2, 'pending');
      await seedStep(taskId, DONE, 3, 'done');
      const doneBefore = (await stepsOf(taskId)).find((s) => s.stepId === DONE);

      const ended = await settle(runCancel(taskId));

      expect.soft(describeOutcome(ended), 'the job').toBe('resolved');
      const task = await taskView(taskId);
      expect.soft(task.status, 'task status').toBe('cancelled');
      expect
        .soft(msOf(task.completedAt), 'completed_at after the seeded time')
        .toBeGreaterThan(msOf(T0));
      expect.soft(task.orchestrationEpoch, 'orchestration_epoch').toBe(EPOCH + 1);
      await expectEndedOpenStepRows(taskId, [RUNNING, PENDING]);
      expect
        .soft(
          (await stepsOf(taskId)).find((s) => s.stepId === DONE),
          'the done step row',
        )
        .toEqual(doneBefore);
      expect
        .soft(
          (await eventsOfType(taskId, 'task.cancelled')).map((e) => e.payload),
          "'task.cancelled' events",
        )
        .toMatchObject([{ source: 'worker' }]);
      expect
        .soft(await eventsOfType(taskId, 'task.cancel_finished'), "'task.cancel_finished' events")
        .toHaveLength(1);
      expectTeardownRan(taskId);
    }

    it('W1: a CANCEL for a completed task changes nothing and tears nothing down', async () => {
      const taskId = await seedTask('completed', { completedAt: T0 });
      await seedStep(taskId, 'step-1', 1, 'done');
      await seedStep(taskId, 'step-2', 2, 'done');
      // A row opened after the completion. The step sweep would fail it, so it shows the job sweeps
      // nothing.
      await seedStep(taskId, 'step-late', 3, 'pending');
      await db
        .insert(schema.taskEvents)
        .values({ taskId, eventType: 'task.completed', payload: {}, createdAt: T0 });
      const before = {
        task: await taskView(taskId),
        steps: await stepsOf(taskId),
        events: await eventsOf(taskId),
      };

      const ended = await settle(runCancel(taskId));

      expect.soft(describeOutcome(ended), 'the job').toBe('resolved');
      expect.soft(await taskView(taskId), 'task row').toEqual(before.task);
      expect.soft(await eventsOf(taskId), 'task_events rows').toEqual(before.events);
      expect.soft(await stepsOf(taskId), 'step rows').toEqual(before.steps);
      expect.soft(h.calls, 'teardown seams the job reached').toEqual([]);
    });

    it('W2: a CANCEL for a task that does not exist resolves and tears nothing down', async () => {
      const ended = await settle(runCancel(randomUUID()));

      expect.soft(describeOutcome(ended), 'the job').toBe('resolved');
      expect.soft(h.calls, 'teardown seams the job reached').toEqual([]);
    });

    it('W3: a CANCEL for a running task cancels it, ends its open steps and tears it down', async () => {
      await cancelsAnOpenTask('running', {});
    });

    it('W4: a CANCEL for a failed task cancels it as it does a running one', async () => {
      await cancelsAnOpenTask('failed', { errorMessage: 'boom', completedAt: T0 });
    });

    it('W5: a CANCEL for a task the api already cancelled keeps its stamp and still runs the teardown', async () => {
      const taskId = await seedTask('cancelled', { completedAt: T0 });
      // The api's cancel ended the rows it held; this one was created after it.
      await seedStep(taskId, 'step-late', 1, 'pending');
      await db
        .insert(schema.taskEvents)
        .values({ taskId, eventType: 'task.cancelled', payload: { by: userId }, createdAt: T0 });

      const ended = await settle(runCancel(taskId));

      expect.soft(describeOutcome(ended), 'the job').toBe('resolved');
      const task = await taskView(taskId);
      expect.soft(task.status, 'task status').toBe('cancelled');
      expect.soft(task.completedAt, "completed_at is still the api cancel's").toEqual(T0);
      expect
        .soft(task.orchestrationEpoch, "orchestration_epoch is still the api cancel's")
        .toBe(EPOCH);
      await expectEndedOpenStepRows(taskId, ['step-late']);
      // The newest 'task.cancelled' event is what the stalled re-drive spaces its retries on, so the
      // job writes its own after the api's.
      expect
        .soft(
          (await eventsOfType(taskId, 'task.cancelled')).map((e) => e.payload),
          "'task.cancelled' events, oldest first",
        )
        .toMatchObject([{ by: userId }, { source: 'worker' }]);
      expect
        .soft(await eventsOfType(taskId, 'task.cancel_finished'), "'task.cancel_finished' events")
        .toHaveLength(1);
      expectTeardownRan(taskId);
    });

    it(
      'W6: a CANCEL that waits for a completion leaves the task completed, with no event and no teardown',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId, 'step-1', 1, 'done');

        const run = await interleave(
          taskId,
          { first: completeTask(taskId) },
          async () => undefined,
        );

        expect.soft(run.failures, 'errors').toEqual([]);
        const task = await taskView(taskId);
        expect.soft(task.status, 'task status').toBe('completed');
        expect.soft(task.completedAt, "completed_at is the completion's").toEqual(COMPLETED_AT);
        expect.soft(task.orchestrationEpoch, 'orchestration_epoch').toBe(EPOCH);
        expect
          .soft(await eventsOfType(taskId, 'task.cancelled'), "'task.cancelled' events")
          .toEqual([]);
        expect.soft(h.calls, 'teardown seams the job reached').toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      'W7: a CANCEL that waits for a step row does not hold the task row, so a claim beside it cannot deadlock',
      async () => {
        const taskId = await seedTask('running');
        await seedAB(taskId, 'pending', 'running');

        // The peer locks A as a pass that is claiming it does, waits until the job is blocked on A,
        // then reads the task row FOR SHARE as the claim's fence read does and commits. A job that
        // held the task row while it waited for A would make that read wait for the job: 40P01.
        const run = await interleave(
          taskId,
          { first: lockStepRow(A.id), second: readTaskRowShared(taskId) },
          () => taskRowHeld(taskId),
        );

        expect.soft(run.failures, 'errors').toEqual([]);
        expect
          .soft(run.observed, 'the job held the task row while it waited for a step row')
          .toBe(false);
        expect.soft((await taskView(taskId)).status, 'task status').toBe('cancelled');
        await expectEndedOpenStepRows(taskId, [A.stepId, B.stepId]);
      },
      TEST_TIMEOUT,
    );
  },
);
