import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  schema,
  type Database,
} from '@haive/database';
import { TASK_JOB_NAMES, configService } from '@haive/shared';
import {
  processTaskJob,
  recoverParkedStep,
  reconcileOrphanedSteps,
  setContainerCleanupRunner,
  type ParkedOrphan,
  type ReconcileDeps,
} from '../src/queues/task-queue.js';
import {
  appendInsightBatch,
  ensureInsightIntent,
  loadInsightBatchRecords,
} from '../src/step-engine/steps/workflow/_insight-batch.js';
import type {
  AgentMiningResult,
  StepContext,
  StepDefinition,
} from '../src/step-engine/step-definition.js';
import { StepSupersededError } from '../src/step-engine/step-ownership.js';
import * as runner from '../src/step-engine/step-runner.js';
import * as dispatcher from '../src/orchestrator/dispatcher.js';
import { redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import { holdReopenedForm } from '../src/step-engine/step-runner.js';

const url = process.env.WORKER_LOCK_TIER_ORDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worker_lock_tier_order_test'))
  throw new Error(
    'Use a dedicated worker_lock_tier_order_test database for the worker lock-tier order tests',
  );

// Lock tiers, as every Retry-family transaction takes them: runs (cli_invocations), then agent minings
// (task_step_agent_minings), then step rows (id order), then the task row. A worker writer that holds a
// step row and then waits for a run or a mining row, or for a lower step row, meets a Retry that holds
// that run, mining or step row and wants the step row the writer holds (40P01).
//
// W1, W2, W3 and the sanity pair are two-connection interleaves. The peer takes `first`, the code under
// test starts and blocks on it, a third connection asks whether the code under test holds the step row it
// was asked about (NOWAIT), then the peer takes `second` and commits. A writer that waits holding nothing
// of a higher tier lets the peer through and finishes; one that holds the step row while it waits closes
// a cycle with the peer. The b and c cases run beside no peer: they pin what the code must keep doing
// whichever order it takes its locks in.
//
// The rows of the cases are named S (a step row), R (a run of S), M (an agent mining row of S) and, for
// the CANCEL job, A (lower id) and B (higher id), inserted B then A with step ids that make every scan
// order (physical, task_id index, the unique task/step/round index) reach B first.
//
// This file drives the real processTaskJob for the CANCEL job. No docker, Redis or git is touched: each
// teardown seam is replaced by a recorder (h.calls), the one docker call the job makes itself (the
// label sweep in task-queue.ts) is a stubbed spawn, and the queue and Redis clients are fakes.
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
// Cross-package controls exercise the actual API action transactions. Only external
// delivery/kill/config I/O is faked; task/run/step mutations use this dedicated DB.
vi.mock('../../api/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../api/src/queues.js', () => ({
  getTaskQueue: () => ({ add: async () => ({ id: 'queued' }) }),
}));
vi.mock('../../api/src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));

vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
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
type StepInsert = Partial<typeof schema.taskSteps.$inferInsert>;
type RunInsert = Partial<typeof schema.cliInvocations.$inferInsert>;
type StepRow = { id: string; stepId: string; stepIndex: number };

/** The seeded rows were last written then; the CANCEL job stamps a later time. */
const T0 = new Date('2026-01-15T10:00:00.000Z');
/** The time a reopened form's consumed agent rows are stamped with. */
const AT = new Date('2026-10-31T12:00:00.000Z');
const EPOCH = 5;
const CANCELLED = 'Task cancelled';
/** What a Stop left on a step row the CANCEL job must not rewrite. */
const STOPPED = 'Stopped by user';
// VOLATILE: a copy of ABANDONED_RUN_MESSAGE in task-queue.ts. A reword fails W1 loudly, on this line.
const ABANDONED_RUN_MESSAGE =
  'CLI invocation superseded by a worker restart (the task had moved past its step)';
const BLIND_INDEX = 'worker-lock-tier-order-test-user';
/** A path nothing creates, so even a seam that escaped its recorder would find no repository on disk. */
const NO_SUCH_DIR = path.join(os.tmpdir(), 'worker-lock-tier-order-test-no-such-dir');
const ORPHAN_AGE_MS = 10 * 60_000;
const BLOCKED_WITHIN_MS = 10_000;
const SEED_ATTEMPTS = 10;
const TEST_TIMEOUT = 30_000;

/** What the carried_* fold adds to, and the live figures it folds. */
const SEED = { work: 1000, idle: 200, user: 50, liveIdle: 4000, liveUser: 800 } as const;

// task_steps.id is a random uuid; A (lower) and B (higher) fix the id order the CANCEL case needs.
const A = { id: '00000000-0000-4000-8000-0000000000a1', stepId: 'step-b', stepIndex: 2 } as const;
const B = { id: '00000000-0000-4000-8000-0000000000b1', stepId: 'step-a', stepIndex: 1 } as const;
/** The step row of the run and mining cases. */
const S = { id: '00000000-0000-4000-8000-0000000000d1', stepId: 'step-s', stepIndex: 1 } as const;
/** A run of S. */
const R = '00000000-0000-4000-8000-0000000000e1';
/** An agent mining row of S. */
const M = '00000000-0000-4000-8000-0000000000f1';
const AGENT = 'agent-reopened-form';
/** The step the task has moved on to, so S is an abandoned orphan. */
const MOVED_ON = 'step-the-task-moved-here';
const NAMES: Record<string, string> = { [A.id]: 'A', [B.id]: 'B', [S.id]: 'S' };

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const describeError = (error: unknown): string =>
  hasPgCode(error, '40P01') ? 'deadlock detected (40P01)' : String(error);

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

const lockRun =
  (id: string): Lock =>
  (tx) =>
    tx
      .select({ id: schema.cliInvocations.id })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, id))
      .for('no key update');

const lockMining =
  (id: string): Lock =>
  (tx) =>
    tx
      .select({ id: schema.taskStepAgentMinings.id })
      .from(schema.taskStepAgentMinings)
      .where(eq(schema.taskStepAgentMinings.id, id))
      .for('no key update');

describe.skipIf(!url)(
  'worker writers that hold a step row while they wait for a run, a mining row or a lower step row, on Postgres',
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
          emailEncrypted: 'worker-lock-tier-order-test@test.local',
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
          name: 'worker-lock-tier-order',
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
      // The one process the CANCEL job starts itself is the docker label sweep, answered by the stub.
      // Anything else (git, another tool) means a teardown path escaped its recorder.
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
          title: 'worker lock tier order',
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
      row: StepRow,
      status: StepStatus,
      over: StepInsert = {},
    ) => {
      await db.insert(schema.taskSteps).values({
        id: row.id,
        taskId,
        stepId: row.stepId,
        stepIndex: row.stepIndex,
        title: row.stepId,
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
    const seedAB = async (taskId: string, b: StepStatus, a: StepStatus, over: StepInsert = {}) => {
      for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt++) {
        await db.delete(schema.taskSteps).where(inArray(schema.taskSteps.id, [A.id, B.id]));
        await seedStep(taskId, B, b, over);
        await seedStep(taskId, A, a, over);
        const scan = await db.execute<{ id: string }>(
          sql`select id from task_steps where task_id = ${taskId} order by ctid`,
        );
        if (scan.map((row) => row.id).join() === [B.id, A.id].join()) return;
      }
      throw new Error('test setup: no scan order reached B before A');
    };

    /** A run of S that is queued: recorded, not started, not ended. */
    const seedRun = async (taskId: string, over: RunInsert = {}) => {
      await db.insert(schema.cliInvocations).values({
        id: R,
        taskId,
        taskStepId: S.id,
        mode: 'cli',
        prompt: 'a run of S',
        ...over,
      });
    };

    const seedMining = async (
      over: Partial<typeof schema.taskStepAgentMinings.$inferInsert> = {},
    ) => {
      await db.insert(schema.taskStepAgentMinings).values({
        id: M,
        taskStepId: S.id,
        agentId: AGENT,
        status: 'done',
        ...over,
      });
    };

    const rowOf = async (id: string) =>
      (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, id) }))!;
    const runOf = async (id: string) =>
      (await db.query.cliInvocations.findFirst({ where: eq(schema.cliInvocations.id, id) }))!;
    const miningOf = async (id: string) =>
      (await db.query.taskStepAgentMinings.findFirst({
        where: eq(schema.taskStepAgentMinings.id, id),
      }))!;
    const stepsOf = (taskId: string) =>
      db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(asc(schema.taskSteps.stepIndex));

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
      // Through a promise, so a code under test that throws before it awaits (a missing function) fails
      // this case instead of leaving the peer's transaction open for the cases after it.
      const underTest = settle(Promise.resolve().then(codeUnderTest));
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

    /** A Retry's order: it holds a run (or an agent mining row) and then wants the step row. */
    const runThenStepPeer = { first: lockRun(R), second: lockStepRow(S.id) };
    const miningThenStepPeer = { first: lockMining(M), second: lockStepRow(S.id) };
    /** An id-ordered whole-task batch taker caught mid-way: it holds the lowest row and wants the next. */
    const idOrderedPeer = { first: lockStepRow(A.id), second: lockStepRow(B.id) };

    /** S, parked on its CLI, in a task that has moved on to another step, and the queue state boot reads. */
    const abandonedOrphan = (taskId: string) => {
      const orphan: ParkedOrphan = {
        taskStepId: S.id,
        taskId,
        stepId: S.stepId,
        round: 0,
        userId,
        epoch: EPOCH,
        currentStepId: MOVED_ON,
        currentRound: 0,
      };
      const enqueueAdvance = vi.fn(async () => undefined);
      const deps: ReconcileDeps = {
        enqueueAdvance,
        queuedInvocationIds: async () => new Set([R]),
      };
      return { orphan, deps, enqueueAdvance, queued: new Set([R]) };
    };

    const reopenedAgent = (): AgentMiningResult => ({
      agentId: AGENT,
      agentTitle: null,
      invocationId: null,
      status: 'done',
      output: null,
      rawOutput: null,
      errorMessage: null,
    });

    /** The reopened form S holds: what holdReopenedForm clears. */
    const OPEN_FORM = {
      detectOutput: { reopened: true },
      formSchema: { fields: [] },
      formValues: { answer: 'kept until the hold' },
    } satisfies StepInsert;

    describe('approved pre-form continuation checkpoint', () => {
      const checkpoint = (ctx: StepContext, invocationId: string | null = R) =>
        (
          runner as unknown as {
            checkpointPreFormContinuation: (
              db: Database,
              ctx: StepContext,
              invocationId: string | null,
            ) => Promise<unknown>;
          }
        ).checkpointPreFormContinuation(db, ctx, invocationId);
      const setup = async () => {
        const taskId = await seedTask('waiting_user', { currentStepId: S.stepId, currentRound: 0 });
        await seedStep(taskId, S, 'running', {
          ...OPEN_FORM,
          rerunGeneration: 4,
          pauseFormOnRetry: false,
        });
        await seedRun(taskId, {
          endedAt: T0,
          exitCode: 0,
          tokenUsage: { costUsd: 0.1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        const ctx = {
          db,
          taskId,
          taskStepId: S.id,
          userId,
          epoch: EPOCH,
          round: 0,
          rerunGeneration: 4,
          logger: { warn: vi.fn() },
        } as unknown as StepContext;
        return { taskId, ctx };
      };
      const taskOf = (taskId: string) =>
        db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });

      const continuationStep = (): StepDefinition => ({
        metadata: {
          id: S.stepId,
          index: S.stepIndex,
          title: 'Continuation fixture',
          description: 'Real-store continuation control',
          workflowType: 'workflow',
          requiresCli: false,
        },
        attachmentContext: 'none',
        detect: vi.fn(async () => ({ revision: 'fresh' })),
        form: () => ({
          title: 'Fresh decision',
          fields: [{ id: 'approve', type: 'checkbox', label: 'Approve' }],
        }),
        llm: {
          preForm: true,
          requiredCapabilities: [],
          buildPrompt: () => 'Review fresh inputs',
          prepare: vi.fn(async () => {}),
        },
        apply: vi.fn(async () => ({ complete: true })),
      });

      async function decisionHarness(checkpointBefore = true) {
        const { taskId, ctx } = await setup();
        if (checkpointBefore) await checkpoint(ctx);
        else
          await db
            .update(schema.cliInvocations)
            .set({ consumedAt: AT })
            .where(eq(schema.cliInvocations.id, R));
        vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
        vi.spyOn(configService, 'get').mockResolvedValue(null);
        vi.spyOn(dispatcher, 'resolveTaskDispatch').mockResolvedValue({
          mode: 'cli',
          providerId: null,
          invocation: { kind: 'cli', spec: {} },
        } as unknown as Awaited<ReturnType<typeof dispatcher.resolveTaskDispatch>>);
        vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
        const step = continuationStep();
        step.detect = vi.fn(async () => ({
          calls: (
            await db.query.cliInvocations.findMany({
              where: eq(schema.cliInvocations.taskStepId, S.id),
            })
          ).length,
        }));
        (step.llm as unknown as Record<string, unknown>).allowPreFormDecisionFallback = true;
        step.llm!.completePreForm = vi.fn(async ({ llmOutput }) => ({
          llmOutput,
          continueRequested: false,
        }));
        const enqueue = vi.fn(async () => {});
        let reservation = '';
        const refuse = async () => {
          const sdk = await import('@haive/shared/step');
          throw new (
            sdk as unknown as { StepPrepareFormError: new () => Error }
          ).StepPrepareFormError();
        };
        step.llm!.prepareWorkspace = async () => {
          const runs = await db.query.cliInvocations.findMany({
            where: eq(schema.cliInvocations.taskStepId, S.id),
          });
          reservation = runs.find((run) => !run.endedAt && !run.supersededAt)!.id;
          await refuse();
        };
        const advance = async (handle = db) =>
          runner.advanceStep({
            db: handle,
            taskId,
            userId,
            stepDef: step,
            repoPath: NO_SUCH_DIR,
            workspacePath: NO_SUCH_DIR,
            cliProviderId: null,
            epoch: (await taskOf(taskId))!.orchestrationEpoch,
            providers: [],
            deps: { enqueueCliInvocation: enqueue },
            formValues: { stale: true },
          });
        return { taskId, ctx, step, enqueue, advance, refuse, reservation: () => reservation };
      }

      describe('decision fallback real-store controls', () => {
        afterEach(() => {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        });

        it('cleans only the inserted id, keeps paid history, and builds an actual new form without enqueue', async () => {
          const f = await decisionHarness();
          const paid = await runOf(R);
          const result = await f.advance();
          expect(result.status).toBe('waiting_form');
          expect((await rowOf(S.id)).detectOutput).toEqual({ calls: 2 });
          expect(await runOf(R)).toEqual(paid);
          expect(await runOf(f.reservation())).toMatchObject({
            endedAt: expect.any(Date),
            supersededAt: expect.any(Date),
            consumedAt: expect.any(Date),
            startedAt: null,
          });
          expect(await rowOf(S.id)).toMatchObject({
            status: 'waiting_form',
            formValues: null,
            rerunGeneration: 4,
          });
          expect(await taskOf(f.taskId)).toMatchObject({
            status: 'running',
            orchestrationEpoch: EPOCH,
          });
          expect(f.step.llm!.completePreForm).toHaveBeenLastCalledWith(
            expect.objectContaining({ llmOutput: null, llmInvocationId: null }),
          );
          expect(f.enqueue).not.toHaveBeenCalled();
          expect(f.step.apply).not.toHaveBeenCalled();
        });

        it.each(['fresh', 'startedAt', 'endedAt', 'supersededAt', 'consumedAt'] as const)(
          'non-fence checkpoint DB error releases only the eligible reservation: %s',
          async (moved) => {
            const f = await decisionHarness();
            const paid = await runOf(R);
            // A separate live reservation must never be selected by the release.
            const otherTask = await seedTask('running');
            await seedStep(otherTask, A, 'running');
            const otherId = randomUUID();
            await seedRun(otherTask, { id: otherId, taskStepId: A.id });
            const other = await runOf(otherId);
            const fault = new Error('injected checkpoint database error');
            let injected = false;
            let beforeRelease: Awaited<ReturnType<typeof runOf>> | undefined;
            const handle = new Proxy(db, {
              get(target, prop) {
                if (prop !== 'transaction') return Reflect.get(target, prop);
                return async (fn: (tx: Tx) => Promise<unknown>) => {
                  let releasing = false;
                  try {
                    return await target.transaction(async (tx) =>
                      fn(
                        new Proxy(tx, {
                          get(transaction, method) {
                            if (method === 'update')
                              return (table: unknown) => {
                                const update = transaction.update(
                                  table as typeof schema.cliInvocations,
                                );
                                if (table !== schema.cliInvocations) return update;
                                return new Proxy(update, {
                                  get(builder, key) {
                                    if (key !== 'set') return Reflect.get(builder, key);
                                    return (patch: RunInsert) => {
                                      if (patch.endedAt && patch.consumedAt) releasing = true;
                                      return builder.set(patch);
                                    };
                                  },
                                });
                              };
                            if (method === 'select' && releasing && !injected)
                              return () => {
                                // The exact-id UPDATE really ran. Fail the next statement
                                // before its step lock; Postgres must roll the UPDATE back.
                                injected = true;
                                throw fault;
                              };
                            return Reflect.get(transaction, method);
                          },
                        }),
                      ),
                    );
                  } catch (err) {
                    if (err !== fault) throw err;
                    const rolledBack = await runOf(f.reservation());
                    expect(rolledBack).toMatchObject({
                      startedAt: null,
                      endedAt: null,
                      supersededAt: null,
                      consumedAt: null,
                    });
                    // Model a peer's committed move between rollback and the guarded
                    // supersede-only release. Each null predicate must stand alone.
                    if (moved !== 'fresh')
                      await db
                        .update(schema.cliInvocations)
                        .set({ [moved]: AT })
                        .where(eq(schema.cliInvocations.id, f.reservation()));
                    beforeRelease = await runOf(f.reservation());
                    throw err;
                  }
                };
              },
            });
            const result = await f.advance(handle);
            expect(injected).toBe(true);
            expect(result.status).toBe('failed');
            expect(result.status === 'failed' && result.error).toContain(fault.message);
            const after = await runOf(f.reservation());
            if (moved === 'fresh') {
              expect(after.supersededAt).toBeInstanceOf(Date);
              expect({ ...after, supersededAt: null }).toEqual(beforeRelease);
            } else expect(after).toEqual(beforeRelease);
            expect(await runOf(R)).toEqual(paid);
            expect(await runOf(otherId)).toEqual(other);
            expect(f.enqueue).not.toHaveBeenCalled();
            expect(f.step.apply).not.toHaveBeenCalled();
          },
        );

        it.each(['Stop', 'Retry'] as const)(
          'real API %s overtakes workspace refusal without a stale checkpoint',
          async (action) => {
            const f = await decisionHarness();
            // Retry folds the current span into int4 timing; use a recent span, not
            // the historical T0 used by the lock-only fixtures.
            await db
              .update(schema.taskSteps)
              .set({
                startedAt: new Date(),
                idleMs: 0,
                carriedIdleMs: 0,
                carriedWorkMs: 0,
                waitingStartedAt: null,
              })
              .where(eq(schema.taskSteps.id, S.id));
            vi.spyOn(configService, 'getFresh').mockResolvedValue(null);
            let runId = '';
            let runAfter: unknown;
            let stepAfter: unknown;
            let taskAfter: unknown;
            f.step.llm!.prepareWorkspace = async () => {
              runId = (
                await db.query.cliInvocations.findMany({
                  where: and(
                    eq(schema.cliInvocations.taskStepId, S.id),
                    isNull(schema.cliInvocations.endedAt),
                    isNull(schema.cliInvocations.supersededAt),
                  ),
                })
              )[0]!.id;
              const controlPath = new URL('../../api/src/lib/task-control.js', import.meta.url)
                .pathname;
              const { stopActiveCliInvocations } = await import(controlPath);
              expect(
                await stopActiveCliInvocations(db, f.taskId, { failTask: true }),
              ).toMatchObject({ cancelled: 1, stopped: 1 });
              if (action === 'Retry') {
                // Task Retry is admitted from failed; use the real Stop to reach it.
                const retryPath = new URL('../../api/src/routes/tasks/steps.js', import.meta.url)
                  .pathname;
                const { retryTaskAtStep } = await import(retryPath);
                const target = (await db.query.taskSteps.findFirst({
                  where: eq(schema.taskSteps.id, S.id),
                }))!;
                await retryTaskAtStep(db, f.taskId, userId, target);
              }
              runAfter = await runOf(runId);
              stepAfter = await rowOf(S.id);
              taskAfter = await taskOf(f.taskId);
              await f.refuse();
            };
            expect((await f.advance()).status).toBe('superseded');
            expect(await runOf(runId)).toEqual(runAfter);
            expect(await rowOf(S.id)).toEqual(stepAfter);
            expect(await taskOf(f.taskId)).toEqual(taskAfter);
            expect(await runOf(runId)).toMatchObject({
              supersededAt: expect.any(Date),
              endedAt: expect.any(Date),
              consumedAt: null,
            });
            if (action === 'Retry') {
              expect(await rowOf(S.id)).toMatchObject({ rerunGeneration: 5, status: 'pending' });
              expect(await taskOf(f.taskId)).toMatchObject({ orchestrationEpoch: EPOCH + 1 });
            } else expect(await taskOf(f.taskId)).toMatchObject({ status: 'failed' });
            expect(f.enqueue).not.toHaveBeenCalled();
          },
        );

        it.each([
          'started',
          'ended',
          'superseded',
          'generation',
          'owner',
          'epoch',
          'pointer',
          'round',
          'dead',
          'failed task status',
          'Cancel',
        ])('refuses cleanup after %s and rolls back exact-id consumption', async (lost) => {
          const f = await decisionHarness();
          let before: unknown;
          f.step.llm!.prepareWorkspace = async () => {
            const run = (
              await db.query.cliInvocations.findMany({
                where: and(
                  eq(schema.cliInvocations.taskStepId, S.id),
                  isNull(schema.cliInvocations.endedAt),
                  isNull(schema.cliInvocations.supersededAt),
                ),
              })
            )[0]!;
            if (lost === 'started')
              await db
                .update(schema.cliInvocations)
                .set({ startedAt: AT })
                .where(eq(schema.cliInvocations.id, run.id));
            else if (lost === 'ended')
              await db
                .update(schema.cliInvocations)
                .set({ endedAt: AT })
                .where(eq(schema.cliInvocations.id, run.id));
            else if (lost === 'superseded')
              await db
                .update(schema.cliInvocations)
                .set({ supersededAt: AT })
                .where(eq(schema.cliInvocations.id, run.id));
            else if (lost === 'generation')
              await db
                .update(schema.taskSteps)
                .set({ rerunGeneration: 5 })
                .where(eq(schema.taskSteps.id, S.id));
            else if (lost === 'owner')
              await db
                .update(schema.taskSteps)
                .set({ taskId: await seedTask('running') })
                .where(eq(schema.taskSteps.id, S.id));
            else if (lost === 'epoch')
              await db
                .update(schema.tasks)
                .set({ orchestrationEpoch: EPOCH + 1 })
                .where(eq(schema.tasks.id, f.taskId));
            else if (lost === 'pointer')
              await db
                .update(schema.tasks)
                .set({ currentStepId: MOVED_ON })
                .where(eq(schema.tasks.id, f.taskId));
            else if (lost === 'round')
              await db
                .update(schema.tasks)
                .set({ currentRound: 1 })
                .where(eq(schema.tasks.id, f.taskId));
            else if (lost === 'dead')
              await db
                .update(schema.tasks)
                .set({ deadAt: AT })
                .where(eq(schema.tasks.id, f.taskId));
            else
              await db
                .update(schema.tasks)
                .set({ status: lost === 'failed task status' ? 'failed' : 'cancelled' })
                .where(eq(schema.tasks.id, f.taskId));
            before = await runOf(run.id);
            await f.refuse();
            expect.unreachable();
          };
          const result = await f.advance();
          expect(result.status).toBe('superseded');
          const runs = await db.query.cliInvocations.findMany({
            where: eq(schema.cliInvocations.taskStepId, S.id),
          });
          expect(runs.find((run) => run.id !== R)).toEqual(before);
          expect(f.enqueue).not.toHaveBeenCalled();
        });

        it('initial refusal consumes its exact id rather than a newer completed row, clearing an old form and answer atomically', async () => {
          const f = await decisionHarness(false);
          const newerId = randomUUID();
          let ownId = '';
          let newer: unknown;
          f.step.llm!.prepareWorkspace = async () => {
            ownId = (
              await db.query.cliInvocations.findMany({
                where: and(
                  eq(schema.cliInvocations.taskStepId, S.id),
                  isNull(schema.cliInvocations.endedAt),
                  isNull(schema.cliInvocations.supersededAt),
                ),
              })
            )[0]!.id;
            await db
              .update(schema.cliInvocations)
              .set({
                tokenUsage: { costUsd: 0.25, inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              })
              .where(eq(schema.cliInvocations.id, ownId));
            await db.insert(schema.cliInvocations).values({
              id: newerId,
              taskId: f.taskId,
              taskStepId: S.id,
              mode: 'cli',
              prompt: 'newer completed pass',
              endedAt: AT,
              exitCode: 0,
              createdAt: new Date(Date.now() + 1000),
            });
            newer = await runOf(newerId);
            await f.refuse();
          };
          expect((await f.advance()).status).toBe('waiting_form');
          expect(await runOf(newerId)).toEqual(newer);
          expect(await runOf(ownId)).toMatchObject({
            consumedAt: expect.any(Date),
            supersededAt: expect.any(Date),
            endedAt: expect.any(Date),
            tokenUsage: { costUsd: 0.25 },
          });
          expect(await rowOf(S.id)).toMatchObject({
            formValues: null,
            formSchema: { title: 'Fresh decision' },
          });
          expect(f.enqueue).not.toHaveBeenCalled();
          expect(f.step.apply).not.toHaveBeenCalled();
        });

        it('a newer live winner is never selected or consumed by an older refusing pass', async () => {
          const f = await decisionHarness();
          const winnerId = randomUUID();
          let before: unknown;
          f.step.llm!.prepareWorkspace = async () => {
            await db
              .update(schema.cliInvocations)
              .set({ supersededAt: AT })
              .where(
                and(
                  eq(schema.cliInvocations.taskStepId, S.id),
                  isNull(schema.cliInvocations.endedAt),
                ),
              );
            await db.insert(schema.cliInvocations).values({
              id: winnerId,
              taskId: f.taskId,
              taskStepId: S.id,
              mode: 'cli',
              prompt: 'another pass owns this',
            });
            before = await runOf(winnerId);
            await f.refuse();
          };
          const stepBefore = await rowOf(S.id);
          expect((await f.advance()).status).toBe('superseded');
          expect(await runOf(winnerId)).toEqual(before);
          expect(await rowOf(S.id)).toMatchObject({
            status: stepBefore.status,
            formValues: stepBefore.formValues,
          });
          expect(f.enqueue).not.toHaveBeenCalled();
        });

        it.each(['none', 'failed task status', 'Cancel', 'generation change'] as const)(
          'run → step → task cleanup beside a %s peer has no deadlock or stale checkpoint',
          async (action) => {
            const f = await decisionHarness();
            let ready!: (id: string) => void;
            const reached = new Promise<string>((resolve) => {
              ready = resolve;
            });
            let release!: () => void;
            const waiting = new Promise<void>((resolve) => {
              release = resolve;
            });
            f.step.llm!.prepareWorkspace = async () => {
              const run = (
                await db.query.cliInvocations.findMany({
                  where: and(
                    eq(schema.cliInvocations.taskStepId, S.id),
                    isNull(schema.cliInvocations.endedAt),
                    isNull(schema.cliInvocations.supersededAt),
                  ),
                })
              )[0]!;
              ready(run.id);
              await waiting;
              await f.refuse();
            };
            const advance = f.advance();
            const id = await reached;
            const race = await interleave(
              () => {
                release();
                return advance;
              },
              {
                first: lockRun(id),
                second: async (tx) => {
                  if (action === 'none') await lockStepRow(S.id)(tx);
                  else if (action === 'generation change')
                    await tx
                      .update(schema.taskSteps)
                      .set({ rerunGeneration: 5 })
                      .where(eq(schema.taskSteps.id, S.id));
                  else
                    await tx
                      .update(schema.tasks)
                      .set({ status: action === 'failed task status' ? 'failed' : 'cancelled' })
                      .where(eq(schema.tasks.id, f.taskId));
                },
              },
              [S.id],
            );
            expectClean(race);
            expect(race.result?.status).toBe(action === 'none' ? 'waiting_form' : 'superseded');
            expect((await runOf(id)).consumedAt === null).toBe(action !== 'none');
            expect(f.enqueue).not.toHaveBeenCalled();
          },
          TEST_TIMEOUT,
        );

        describe.each(['boot', 'stalled'] as const)('%s schema-save crash recovery', (reader) => {
          it.each([
            'workspace decision',
            'prepare false decision',
            'A1 completed',
            'A1 prepare false',
          ] as const)('parks the saved %s form without repeating pre-form work', async (entry) => {
            const f = await decisionHarness();
            if (entry === 'prepare false decision') {
              await db
                .update(schema.cliInvocations)
                .set({ consumedAt: null, rawOutput: 'completed report' })
                .where(eq(schema.cliInvocations.id, R));
              f.step.llm!.completePreForm = vi.fn(async ({ llmOutput }) => ({
                llmOutput,
                continueRequested: llmOutput != null,
              }));
              f.step.llm!.prepare = vi.fn(async () => false as const);
            } else if (entry.startsWith('A1')) {
              delete f.step.llm!.allowPreFormDecisionFallback;
              if (entry === 'A1 completed')
                await seedRun(f.taskId, {
                  id: randomUUID(),
                  endedAt: AT,
                  exitCode: 0,
                  rawOutput: 'fresh completed pass',
                });
              else f.step.llm!.prepare = vi.fn(async () => false as const);
            }
            let injected = false;
            const handle = new Proxy(db, {
              get(target, prop) {
                if (prop !== 'update') return Reflect.get(target, prop);
                return (table: typeof schema.taskSteps) => {
                  const update = target.update(table);
                  if (table !== schema.taskSteps) return update;
                  return new Proxy(update, {
                    get(builder, key) {
                      if (key !== 'set') return Reflect.get(builder, key);
                      return (patch: StepInsert) => {
                        // Kill the pass before its park UPDATE, after the separate
                        // schema write has committed to the real database.
                        if (patch.status === 'waiting_form' && !injected) {
                          injected = true;
                          throw new StepSupersededError(S.id);
                        }
                        return builder.set(patch);
                      };
                    },
                  });
                };
              },
            });
            expect((await f.advance(handle)).status).toBe('superseded');
            expect(injected).toBe(true);
            const saved = await rowOf(S.id);
            expect(saved).toMatchObject({
              status: 'waiting_cli',
              pauseFormOnRetry: true,
              formSchema: { title: 'Fresh decision' },
              formValues: null,
              errorMessage: null,
              rerunGeneration: 4,
            });
            const queue = vi.fn(async () => {});
            if (reader === 'boot')
              await reconcileOrphanedSteps(db, {
                enqueueAdvance: queue,
                queuedInvocationIds: async () => new Set(),
              });
            else {
              await db
                .update(schema.tasks)
                .set({ updatedAt: T0 })
                .where(eq(schema.tasks.id, f.taskId));
              await redriveStalledTasks(
                db,
                {
                  queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
                  enqueueAdvance: queue,
                  enqueueStart: async () => {},
                  failTask: async () => false,
                  queuedInvocationIds: async () => new Set(),
                },
                { staleMs: 0 },
              );
            }
            expect(queue).toHaveBeenCalledOnce();
            expect((await taskOf(f.taskId))!.orchestrationEpoch).toBe(EPOCH + 1);
            const runsBefore = await db.query.cliInvocations.findMany({
              where: eq(schema.cliInvocations.taskStepId, S.id),
              orderBy: asc(schema.cliInvocations.id),
            });
            f.step.llm!.prepare = vi.fn(async () => {
              throw new Error('must not prepare after schema save');
            });
            f.step.llm!.prepareWorkspace = vi.fn(async () => {
              throw new Error('must not reserve after schema save');
            });
            vi.mocked(f.step.llm!.completePreForm!).mockClear();
            const dispatch = vi.mocked(dispatcher.resolveTaskDispatch).mockClear();
            const result = await f.advance();
            expect(result.status).toBe('waiting_form');
            expect(result.status === 'waiting_form' && result.formSchema).toEqual(saved.formSchema);
            expect(await rowOf(S.id)).toMatchObject({
              status: 'waiting_form',
              waitingStartedAt: expect.any(Date),
              pauseFormOnRetry: false,
              formSchema: saved.formSchema,
              formValues: null,
              errorMessage: null,
              rerunGeneration: 4,
            });
            expect(f.step.llm!.prepare).not.toHaveBeenCalled();
            expect(f.step.llm!.prepareWorkspace).not.toHaveBeenCalled();
            expect(f.step.llm!.completePreForm).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
            expect(f.enqueue).not.toHaveBeenCalled();
            expect(f.step.apply).not.toHaveBeenCalled();
            expect(
              await db.query.cliInvocations.findMany({
                where: eq(schema.cliInvocations.taskStepId, S.id),
                orderBy: asc(schema.cliInvocations.id),
              }),
            ).toEqual(runsBefore);
            expect((await taskOf(f.taskId))!.status).toBe('running');
          });
        });

        describe.each(['boot', 'stalled'] as const)('%s refusal recovery', (reader) => {
          it.each([
            ['workspace', 'before'],
            ['workspace', 'after'],
            ['prepare false', 'before'],
            ['prepare false', 'after'],
          ] as const)(
            'crash %s %s the cleanup checkpoint recovers without dispatch after durable refusal',
            async (entry, cut) => {
              const f = await decisionHarness(entry !== 'prepare false');
              if (entry === 'prepare false') {
                await db
                  .update(schema.cliInvocations)
                  .set({ consumedAt: null, rawOutput: 'completed report' })
                  .where(eq(schema.cliInvocations.id, R));
                f.step.llm!.completePreForm = vi.fn(async ({ llmOutput }) => ({
                  llmOutput,
                  continueRequested: llmOutput != null,
                }));
                f.step.llm!.prepare = vi.fn(async () => false as const);
              }
              let injected = false;
              const handle = new Proxy(db, {
                get(target, prop) {
                  if (prop !== 'transaction') return Reflect.get(target, prop);
                  return async (fn: (tx: Tx) => Promise<unknown>) => {
                    let decision = false;
                    const result = await target.transaction(async (tx) => {
                      const value = await fn(tx);
                      const events = await tx.query.taskEvents.findMany({
                        where: and(
                          eq(schema.taskEvents.taskStepId, S.id),
                          eq(schema.taskEvents.eventType, 'step.pre_form_continuation'),
                        ),
                      });
                      decision = events.some((event) => event.payload?.decisionForm === true);
                      if (decision && !injected && cut === 'before') {
                        injected = true;
                        throw new StepSupersededError(S.id);
                      }
                      return value;
                    });
                    if (decision && !injected && cut === 'after') {
                      injected = true;
                      throw new StepSupersededError(S.id);
                    }
                    return result;
                  };
                },
              });
              expect((await f.advance(handle)).status).toBe('superseded');
              expect(injected).toBe(true);
              if (entry === 'workspace') {
                const run = await runOf(f.reservation());
                expect(run.consumedAt === null).toBe(cut === 'before');
              } else {
                expect((await runOf(R)).consumedAt).toBeInstanceOf(Date);
                expect(
                  await db.query.cliInvocations.findMany({
                    where: eq(schema.cliInvocations.taskStepId, S.id),
                  }),
                ).toHaveLength(1);
              }
              const queue = vi.fn(async () => {});
              if (reader === 'boot')
                await reconcileOrphanedSteps(db, {
                  enqueueAdvance: queue,
                  queuedInvocationIds: async () => new Set(),
                });
              else {
                await db
                  .update(schema.tasks)
                  .set({ updatedAt: T0 })
                  .where(eq(schema.tasks.id, f.taskId));
                await redriveStalledTasks(
                  db,
                  {
                    queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
                    enqueueAdvance: queue,
                    enqueueStart: async () => {},
                    failTask: async () => false,
                    queuedInvocationIds: async () => new Set(),
                  },
                  { staleMs: 0 },
                );
              }
              expect(queue).toHaveBeenCalledOnce();
              if (cut === 'after') {
                f.step.llm!.prepare = vi.fn(async () => {
                  throw new Error('must not prepare after refusal');
                });
              }
              expect((await f.advance()).status).toBe('waiting_form');
              expect(f.enqueue).not.toHaveBeenCalled();
              expect(f.step.apply).not.toHaveBeenCalled();
            },
          );
        });
      });

      it('reads the persisted opt-in event and refuses its stale generation after a Retry-order update', async () => {
        const { ctx } = await setup();
        await checkpoint(ctx);
        const step = continuationStep();
        expect(await runner.isHeldPreFormContinuation(db, step, await rowOf(S.id))).toBe(true);
        await peer.transaction(async (tx) => {
          await tx
            .update(schema.cliInvocations)
            .set({ supersededAt: AT })
            .where(eq(schema.cliInvocations.taskStepId, S.id));
          await tx
            .update(schema.taskSteps)
            .set({ rerunGeneration: sql`${schema.taskSteps.rerunGeneration} + 1` })
            .where(eq(schema.taskSteps.id, S.id));
        });
        expect(await runner.isHeldPreFormContinuation(db, step, await rowOf(S.id))).toBe(false);
      });

      it.each([
        'missing event',
        'version',
        'generation',
        'answer',
        'hold',
        'latest checkpoint',
      ] as const)('a saved schema cannot bypass checkpoint binding: %s', async (lost) => {
        const { taskId, ctx } = await setup();
        await checkpoint(ctx);
        await db
          .update(schema.taskSteps)
          .set({
            formSchema: { title: 'Saved fresh form', fields: [] },
            ...(lost === 'answer' ? { formValues: {} } : {}),
            ...(lost === 'hold' ? { pauseFormOnRetry: false } : {}),
          })
          .where(eq(schema.taskSteps.id, S.id));
        const step = continuationStep();
        expect(await runner.isHeldPreFormContinuation(db, step, await rowOf(S.id))).toBe(
          lost !== 'answer' && lost !== 'hold',
        );
        if (lost === 'missing event')
          await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId));
        else if (lost === 'version' || lost === 'generation')
          await db
            .update(schema.taskEvents)
            .set({
              payload: {
                version: lost === 'version' ? 2 : 1,
                rerunGeneration: lost === 'generation' ? 3 : 4,
              },
            })
            .where(eq(schema.taskEvents.taskId, taskId));
        else if (lost === 'latest checkpoint')
          await db.insert(schema.taskEvents).values({
            taskId,
            taskStepId: S.id,
            eventType: 'step.pre_form_continuation',
            payload: { version: 2, rerunGeneration: 4 },
            createdAt: new Date(Date.now() + 1_000),
          });
        expect(await runner.isHeldPreFormContinuation(db, step, await rowOf(S.id))).toBe(false);
      });

      it('the latest of several same-generation checkpoints gets its own workspace race allowance', async () => {
        const { taskId, ctx } = await setup();
        const pause = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
        try {
          for (let pass = 0; pass < 3; pass++) {
            await checkpoint(ctx, pass === 0 ? R : null);
            const id = randomUUID();
            await db
              .insert(schema.cliInvocations)
              .values({ id, taskId, taskStepId: S.id, mode: 'cli', prompt: 'workspace race' });
            expect(
              await runner.deferPreFormContinuation(db, ctx, await rowOf(S.id), id, true),
            ).toMatchObject({ status: 'deferred', delayMs: 1_000 });
            expect((await runOf(id)).supersededAt).toBeInstanceOf(Date);
          }
          const checkpoints = await db.query.taskEvents.findMany({
            where: and(
              eq(schema.taskEvents.taskStepId, S.id),
              eq(schema.taskEvents.eventType, 'step.pre_form_continuation'),
            ),
          });
          const races = await db.query.taskEvents.findMany({
            where: and(
              eq(schema.taskEvents.taskStepId, S.id),
              eq(schema.taskEvents.eventType, 'step.pre_form_workspace_resume_deferred'),
            ),
          });
          expect(checkpoints).toHaveLength(3);
          expect(races).toHaveLength(3);
          expect(new Set(races.map((event) => event.payload!.checkpointEventId))).toEqual(
            new Set(checkpoints.map((event) => event.id)),
          );
          expect((await rowOf(S.id)).rerunGeneration).toBe(4);
          expect((await runOf(R)).tokenUsage).toMatchObject({ costUsd: 0.1 });
        } finally {
          pause.mockRestore();
        }
      });

      it.each(['boot', 'stalled'] as const)(
        'a %s-recovered null-form continuation clears the hold only in its owned done write',
        async (reader) => {
          const { taskId, ctx } = await setup();
          await checkpoint(ctx);
          const queue = vi.fn(async () => {});
          if (reader === 'boot')
            await reconcileOrphanedSteps(db, {
              enqueueAdvance: queue,
              queuedInvocationIds: async () => new Set(),
            });
          else
            await redriveStalledTasks(
              db,
              {
                queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
                enqueueAdvance: queue,
                enqueueStart: async () => {},
                failTask: async () => false,
                queuedInvocationIds: async () => new Set(),
              },
              { staleMs: 0 },
            );
          expect(queue).toHaveBeenCalledOnce();
          const task = (await taskOf(taskId))!;
          const step = continuationStep();
          step.llm!.prepare = async () => false;
          step.form = () => null;
          step.apply = vi.fn(async () => {
            expect(await rowOf(S.id)).toMatchObject({
              status: 'waiting_cli',
              pauseFormOnRetry: true,
            });
            return { complete: true };
          });
          const config = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
          const get = vi.spyOn(configService, 'get').mockResolvedValue(null);
          const enqueue = vi.fn(async () => {});
          vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
          try {
            expect(
              (
                await runner.advanceStep({
                  db,
                  taskId,
                  userId,
                  stepDef: step,
                  repoPath: NO_SUCH_DIR,
                  workspacePath: NO_SUCH_DIR,
                  cliProviderId: null,
                  epoch: task.orchestrationEpoch,
                  providers: [],
                  deps: { enqueueCliInvocation: enqueue },
                  formValues: { stale: true },
                })
              ).status,
            ).toBe('done');
            expect(await rowOf(S.id)).toMatchObject({
              status: 'done',
              pauseFormOnRetry: false,
              rerunGeneration: 4,
            });
            expect(step.apply).toHaveBeenCalledOnce();
            expect(enqueue).not.toHaveBeenCalled();
          } finally {
            config.mockRestore();
            get.mockRestore();
            vi.unstubAllEnvs();
          }
        },
      );

      it('held insertion rolls its reservation back when a peer changes generation between insert and fence', async () => {
        const { taskId, ctx } = await setup();
        await checkpoint(ctx);
        const id = randomUUID();
        await expect(
          runner.insertHeldPreFormInvocation(db, ctx, S.stepId, async (handle) => {
            const [run] = await handle
              .insert(schema.cliInvocations)
              .values({
                id,
                taskId,
                taskStepId: S.id,
                mode: 'cli',
                prompt: 'uncommitted reservation',
              })
              .returning();
            await peer
              .update(schema.taskSteps)
              .set({ rerunGeneration: 5 })
              .where(eq(schema.taskSteps.id, S.id));
            return run;
          }),
        ).rejects.toBeInstanceOf(StepSupersededError);
        expect(
          await db.query.cliInvocations.findFirst({ where: eq(schema.cliInvocations.id, id) }),
        ).toBeUndefined();
        expect((await rowOf(S.id)).rerunGeneration).toBe(5);
        expect((await runOf(R)).consumedAt).toBeInstanceOf(Date);
      });

      it('a boot-recovered checkpoint retains its notice through pause, Resume, dispatch and a fresh form', async () => {
        const { taskId, ctx } = await setup();
        await runner.checkpointPreFormContinuation(db, ctx, R, 'Approved work continued');
        const event = await db.query.taskEvents.findFirst({
          where: and(
            eq(schema.taskEvents.taskStepId, S.id),
            eq(schema.taskEvents.eventType, 'step.pre_form_continuation'),
          ),
        });
        expect(event!.payload).toMatchObject({
          version: 1,
          rerunGeneration: 4,
          notice: 'Approved work continued',
        });
        const queue = vi.fn(async () => {});
        await reconcileOrphanedSteps(db, {
          enqueueAdvance: queue,
          queuedInvocationIds: async () => new Set(),
        });
        expect(queue).toHaveBeenCalledOnce();
        const task = (await taskOf(taskId))!;
        const step = continuationStep();
        const enqueue = vi.fn(async () => {});
        const config = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
        const get = vi.spyOn(configService, 'get').mockResolvedValue(null);
        const dispatch = vi.spyOn(dispatcher, 'resolveTaskDispatch').mockResolvedValue({
          mode: 'cli',
          providerId: null,
          invocation: { kind: 'cli', spec: {} },
        } as unknown as Awaited<ReturnType<typeof dispatcher.resolveTaskDispatch>>);
        vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '0');
        try {
          await db.update(schema.tasks).set({ pausedAt: AT }).where(eq(schema.tasks.id, taskId));
          const advance = () =>
            runner.advanceStep({
              db,
              taskId,
              userId,
              stepDef: step,
              repoPath: NO_SUCH_DIR,
              workspacePath: NO_SUCH_DIR,
              cliProviderId: null,
              epoch: task.orchestrationEpoch,
              providers: [],
              deps: { enqueueCliInvocation: enqueue },
              formValues: { stale: true },
            });
          expect(await advance()).toMatchObject({ status: 'deferred', delayMs: 30_000 });
          expect(step.llm!.prepare).not.toHaveBeenCalled();
          expect(step.apply).not.toHaveBeenCalled();
          expect(enqueue).not.toHaveBeenCalled();
          await db.update(schema.tasks).set({ pausedAt: null }).where(eq(schema.tasks.id, taskId));
          expect((await advance()).status).toBe('waiting_cli');
          expect(enqueue).toHaveBeenCalledOnce();
          expect(step.llm!.prepare).toHaveBeenCalledOnce();
          const runs = await db.query.cliInvocations.findMany({
            where: eq(schema.cliInvocations.taskStepId, S.id),
          });
          expect(runs).toHaveLength(2);
          const fresh = runs.find((run) => run.id !== R)!;
          await db
            .update(schema.cliInvocations)
            .set({ endedAt: AT, exitCode: 0, rawOutput: 'fresh result' })
            .where(eq(schema.cliInvocations.id, fresh.id));
          const result = await advance();
          expect(result.status).toBe('waiting_form');
          if (result.status !== 'waiting_form') throw new Error('expected fresh form');
          expect(result.formSchema.fields).toContainEqual(
            expect.objectContaining({ id: 'reopenedFormNotice', body: 'Approved work continued' }),
          );
          expect(await rowOf(S.id)).toMatchObject({
            pauseFormOnRetry: false,
            formValues: null,
            rerunGeneration: 4,
          });
          expect(step.apply).not.toHaveBeenCalled();
          expect(enqueue).toHaveBeenCalledOnce();
        } finally {
          config.mockRestore();
          get.mockRestore();
          dispatch.mockRestore();
          vi.unstubAllEnvs();
        }
      });

      it('atomically consumes the exact completed id and holds a running task without changing generation, epoch, pointer, spend or downstream', async () => {
        const { taskId, ctx } = await setup();
        await seedStep(taskId, A, 'done', { output: { retained: true } });
        const newer = randomUUID();
        await db
          .insert(schema.cliInvocations)
          .values({ id: newer, taskId, taskStepId: S.id, mode: 'cli', prompt: 'newer live' });
        await db
          .update(schema.taskSteps)
          .set({ waitingStartedAt: new Date(Date.now() - 2_000), idleMs: 7 })
          .where(eq(schema.taskSteps.id, S.id));
        const downstream = await rowOf(A.id);
        const live = await runOf(newer);
        await checkpoint(ctx);
        expect(await rowOf(S.id)).toMatchObject({
          status: 'waiting_cli',
          rerunGeneration: 4,
          detectOutput: null,
          detectCliProviderId: null,
          formSchema: null,
          formValues: null,
          pauseFormOnRetry: true,
          waitingStartedAt: null,
        });
        expect(await taskOf(taskId)).toMatchObject({
          status: 'running',
          orchestrationEpoch: EPOCH,
          currentStepId: S.stepId,
          currentRound: 0,
        });
        expect((await rowOf(S.id)).idleMs).toBeGreaterThanOrEqual(2_007);
        expect((await runOf(R)).consumedAt).toBeInstanceOf(Date);
        expect((await runOf(R)).tokenUsage).toMatchObject({ costUsd: 0.1 });
        expect(await runOf(newer)).toEqual(live);
        expect(await rowOf(A.id)).toEqual(downstream);
        expect(
          await db.query.taskEvents.findMany({
            where: and(
              eq(schema.taskEvents.taskStepId, S.id),
              eq(schema.taskEvents.eventType, 'step.pre_form_continuation'),
            ),
          }),
        ).toMatchObject([{ payload: { version: 1, rerunGeneration: 4 } }]);
      });

      it.each([
        'generation',
        'step-owner',
        'task-owner',
        'epoch',
        'pointer',
        'round',
        'dead',
        'failed',
        'cancelled',
        'completed',
        'pending',
        'skipped',
        'run-superseded',
        'run-live',
      ])('lost %s rolls back consumption and the whole checkpoint', async (lost) => {
        const { taskId, ctx } = await setup();
        if (lost === 'generation')
          await db
            .update(schema.taskSteps)
            .set({ rerunGeneration: 5 })
            .where(eq(schema.taskSteps.id, S.id));
        else if (lost === 'step-owner') ctx.taskId = randomUUID();
        else if (lost === 'task-owner') ctx.userId = randomUUID();
        else if (lost === 'epoch') ctx.epoch = EPOCH - 1;
        else if (lost === 'pointer')
          await db
            .update(schema.tasks)
            .set({ currentStepId: MOVED_ON })
            .where(eq(schema.tasks.id, taskId));
        else if (lost === 'round')
          await db.update(schema.tasks).set({ currentRound: 1 }).where(eq(schema.tasks.id, taskId));
        else if (lost === 'dead')
          await db.update(schema.tasks).set({ deadAt: AT }).where(eq(schema.tasks.id, taskId));
        else if (lost === 'pending' || lost === 'skipped')
          await db
            .update(schema.taskSteps)
            .set({ status: lost })
            .where(eq(schema.taskSteps.id, S.id));
        else if (lost === 'run-superseded')
          await db
            .update(schema.cliInvocations)
            .set({ supersededAt: AT })
            .where(eq(schema.cliInvocations.id, R));
        else if (lost === 'run-live')
          await db
            .update(schema.cliInvocations)
            .set({ endedAt: null })
            .where(eq(schema.cliInvocations.id, R));
        else
          await db
            .update(schema.tasks)
            .set({ status: lost as 'failed' | 'cancelled' | 'completed' })
            .where(eq(schema.tasks.id, taskId));
        const before = { row: await rowOf(S.id), run: await runOf(R), task: await taskOf(taskId) };
        await expect(checkpoint(ctx)).rejects.toBeInstanceOf(StepSupersededError);
        expect(await rowOf(S.id)).toEqual(before.row);
        expect(await runOf(R)).toEqual(before.run);
        expect(await taskOf(taskId)).toEqual(before.task);
      });

      it(
        'takes run before step before task beside a Retry-order peer',
        async () => {
          const { ctx } = await setup();
          expectClean(await interleave(() => checkpoint(ctx), runThenStepPeer, [S.id]));
        },
        TEST_TIMEOUT,
      );

      it(
        'a Retry that overtakes the blocked checkpoint rolls consumption back',
        async () => {
          const { ctx } = await setup();
          const race = await interleave(
            () => settle(checkpoint(ctx)),
            {
              first: lockRun(R),
              second: async (tx) => {
                await tx
                  .update(schema.taskSteps)
                  .set({ rerunGeneration: 5 })
                  .where(eq(schema.taskSteps.id, S.id));
              },
            },
            [S.id],
          );
          expectClean(race);
          expect(race.result?.ok).toBe(false);
          expect((await runOf(R)).consumedAt).toBeNull();
          expect((await rowOf(S.id)).formValues).toEqual(OPEN_FORM.formValues);
        },
        TEST_TIMEOUT,
      );

      it.each(['Stop', 'Cancel', 'Retry'] as const)(
        'a %s overtaking a no-pause workspace release wins',
        async (action) => {
          const { taskId, ctx } = await setup();
          await checkpoint(ctx);
          const current = await rowOf(S.id);
          const id = randomUUID();
          await db
            .insert(schema.cliInvocations)
            .values({ id, taskId, taskStepId: S.id, mode: 'cli', prompt: 'blocked reservation' });
          const before = {
            step: await rowOf(S.id),
            paid: await runOf(R),
            run: await runOf(id),
            task: await taskOf(taskId),
          };
          const pause = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
          try {
            const race = await interleave(
              () => settle(runner.deferPreFormContinuation(db, ctx, current, id, true)),
              {
                first: lockRun(id),
                second: async (tx) => {
                  if (action === 'Retry')
                    await tx
                      .update(schema.taskSteps)
                      .set({ rerunGeneration: 5 })
                      .where(eq(schema.taskSteps.id, S.id));
                  else
                    await tx
                      .update(schema.tasks)
                      .set({ status: action === 'Stop' ? 'failed' : 'cancelled' })
                      .where(eq(schema.tasks.id, taskId));
                },
              },
              [S.id],
            );
            expectClean(race);
            expect(race.result?.ok).toBe(false);
            if (race.result && !race.result.ok)
              expect(race.result.error).toBeInstanceOf(StepSupersededError);
            expect(await runOf(id)).toEqual(before.run);
            expect(await runOf(R)).toEqual(before.paid);
            expect(await rowOf(S.id)).toEqual(
              action === 'Retry' ? { ...before.step, rerunGeneration: 5 } : before.step,
            );
            expect(await taskOf(taskId)).toEqual(
              action === 'Retry'
                ? before.task
                : { ...before.task, status: action === 'Stop' ? 'failed' : 'cancelled' },
            );
            expect(
              await db.query.taskEvents.findMany({
                where: and(
                  eq(schema.taskEvents.taskStepId, S.id),
                  eq(schema.taskEvents.eventType, 'step.pre_form_workspace_resume_deferred'),
                ),
              }),
            ).toHaveLength(0);
          } finally {
            pause.mockRestore();
          }
        },
        TEST_TIMEOUT,
      );

      describe.each([false, true])('reservation release with resumeRace=%s', (resumeRace) => {
        it.each([
          'none',
          'generation',
          'epoch',
          'owner',
          'pointer',
          'round',
          'dead',
          'failed',
          'cancelled',
          'completed',
          'hold',
          'started',
          'superseded',
        ])('reservation release is fenced on %s and retains all paid history', async (lost) => {
          const { taskId, ctx } = await setup();
          await checkpoint(ctx);
          const current = await rowOf(S.id);
          const reservationId = randomUUID();
          await db.insert(schema.cliInvocations).values({
            id: reservationId,
            taskId,
            taskStepId: S.id,
            mode: 'cli',
            prompt: 'unqueued reservation',
          });
          if (lost === 'generation')
            await db
              .update(schema.taskSteps)
              .set({ rerunGeneration: 5 })
              .where(eq(schema.taskSteps.id, S.id));
          else if (lost === 'hold')
            await db
              .update(schema.taskSteps)
              .set({ pauseFormOnRetry: false })
              .where(eq(schema.taskSteps.id, S.id));
          else if (lost === 'epoch') ctx.epoch = EPOCH - 1;
          else if (lost === 'owner') ctx.userId = randomUUID();
          else if (lost === 'pointer')
            await db
              .update(schema.tasks)
              .set({ currentStepId: MOVED_ON })
              .where(eq(schema.tasks.id, taskId));
          else if (lost === 'round')
            await db
              .update(schema.tasks)
              .set({ currentRound: 1 })
              .where(eq(schema.tasks.id, taskId));
          else if (lost === 'dead')
            await db.update(schema.tasks).set({ deadAt: AT }).where(eq(schema.tasks.id, taskId));
          else if (lost === 'started')
            await db
              .update(schema.cliInvocations)
              .set({ startedAt: AT })
              .where(eq(schema.cliInvocations.id, reservationId));
          else if (lost === 'superseded')
            await db
              .update(schema.cliInvocations)
              .set({ supersededAt: AT })
              .where(eq(schema.cliInvocations.id, reservationId));
          else if (lost !== 'none')
            await db
              .update(schema.tasks)
              .set({ status: lost as 'failed' | 'cancelled' | 'completed' })
              .where(eq(schema.tasks.id, taskId));
          const before = {
            run: await runOf(reservationId),
            paid: await runOf(R),
            step: await rowOf(S.id),
            task: await taskOf(taskId),
          };
          const pause = vi.spyOn(configService, 'getBoolean').mockResolvedValue(!resumeRace);
          try {
            const release = runner.deferPreFormContinuation(
              db,
              ctx,
              current,
              reservationId,
              resumeRace,
            );
            if (lost === 'none') {
              await expect(release).resolves.toMatchObject({
                status: 'deferred',
                delayMs: resumeRace ? 1_000 : 30_000,
              });
              expect((await runOf(reservationId)).supersededAt).toBeInstanceOf(Date);
              expect((await rowOf(S.id)).waitingStartedAt).toBeInstanceOf(Date);
              if (resumeRace) {
                const events = await db.query.taskEvents.findMany({
                  where: and(
                    eq(schema.taskEvents.taskStepId, S.id),
                    eq(schema.taskEvents.eventType, 'step.pre_form_workspace_resume_deferred'),
                  ),
                });
                expect(events).toHaveLength(1);
                const checkpointEvent = await db.query.taskEvents.findFirst({
                  where: and(
                    eq(schema.taskEvents.taskStepId, S.id),
                    eq(schema.taskEvents.eventType, 'step.pre_form_continuation'),
                  ),
                });
                expect(events[0]!.payload).toMatchObject({
                  checkpointEventId: checkpointEvent!.id,
                });
                const second = randomUUID();
                await db.insert(schema.cliInvocations).values({
                  id: second,
                  taskId,
                  taskStepId: S.id,
                  mode: 'cli',
                  prompt: 'second reservation',
                });
                await expect(
                  runner.deferPreFormContinuation(db, ctx, await rowOf(S.id), second, true),
                ).rejects.toThrow(/repeated.*pause/);
                expect((await runOf(second)).supersededAt).toBeInstanceOf(Date);
                expect(
                  await db.query.cliInvocations.findMany({
                    where: and(
                      eq(schema.cliInvocations.taskStepId, S.id),
                      isNull(schema.cliInvocations.endedAt),
                      isNull(schema.cliInvocations.supersededAt),
                    ),
                  }),
                ).toHaveLength(0);
              }
            } else {
              await expect(release).rejects.toBeInstanceOf(StepSupersededError);
              expect(await runOf(reservationId)).toEqual(before.run);
              expect(await rowOf(S.id)).toEqual(before.step);
              expect(await taskOf(taskId)).toEqual(before.task);
              expect(
                await db.query.taskEvents.findMany({
                  where: and(
                    eq(schema.taskEvents.taskStepId, S.id),
                    eq(schema.taskEvents.eventType, 'step.pre_form_workspace_resume_deferred'),
                  ),
                }),
              ).toHaveLength(0);
            }
            expect(await runOf(R)).toEqual(before.paid);
          } finally {
            pause.mockRestore();
          }
        });
      });

      it.each(['boot', 'stalled'] as const)(
        'crash before pickup/checkpoint from waiting_user preserves the approved answer through %s recovery',
        async (reader) => {
          const { taskId } = await setup();
          await db
            .update(schema.taskSteps)
            .set({ status: 'waiting_form', waitingStartedAt: null })
            .where(eq(schema.taskSteps.id, S.id));
          const before = await rowOf(S.id);
          const enqueue = vi.fn(async () => {});
          if (reader === 'boot')
            await reconcileOrphanedSteps(db, {
              enqueueAdvance: enqueue,
              queuedInvocationIds: async () => new Set(),
            });
          // Boot calls the stalled sweep after orphan reconciliation.
          await redriveStalledTasks(
            db,
            {
              queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
              enqueueAdvance: enqueue,
              enqueueStart: async () => {},
              failTask: async () => false,
              queuedInvocationIds: async () => new Set(),
            },
            { staleMs: 0 },
          );
          expect(enqueue).toHaveBeenCalledOnce();
          expect(await rowOf(S.id)).toMatchObject({
            status: 'waiting_form',
            detectOutput: before.detectOutput,
            formValues: before.formValues,
            rerunGeneration: 4,
          });
          expect((await runOf(R)).consumedAt).toBeNull();
          expect((await taskOf(taskId))!.orchestrationEpoch).toBe(EPOCH + 1);
        },
      );

      it.each(['boot', 'stalled'] as const)(
        'crash after checkpoint from waiting_user is recovered by the real %s reader',
        async (reader) => {
          const { taskId, ctx } = await setup();
          await checkpoint(ctx);
          const held = await rowOf(S.id);
          // Model an acknowledged checkpoint followed by death before reserve/insert/enqueue.
          const enqueue = vi.fn(async () => {});
          if (reader === 'boot')
            await reconcileOrphanedSteps(db, {
              enqueueAdvance: enqueue,
              queuedInvocationIds: async () => new Set(),
            });
          else {
            await db.update(schema.tasks).set({ updatedAt: T0 }).where(eq(schema.tasks.id, taskId));
            await db
              .update(schema.taskSteps)
              .set({ updatedAt: T0 })
              .where(eq(schema.taskSteps.id, S.id));
            await redriveStalledTasks(
              db,
              {
                queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
                enqueueAdvance: enqueue,
                enqueueStart: async () => {},
                failTask: async () => false,
                queuedInvocationIds: async () => new Set(),
              },
              { staleMs: 0 },
            );
          }
          expect(enqueue).toHaveBeenCalledOnce();
          expect(await rowOf(S.id)).toMatchObject({
            status: 'waiting_cli',
            rerunGeneration: held.rerunGeneration,
            formSchema: null,
            formValues: null,
            pauseFormOnRetry: true,
          });
          expect((await taskOf(taskId))!.orchestrationEpoch).toBe(EPOCH + 1);
          expect((await runOf(R)).consumedAt).toBeInstanceOf(Date);
        },
      );
    });

    // Sanity: the setup can produce the cycle.

    it(
      'WS1: a writer that locks the run and then the step row waits for the run holding nothing, so a peer in the same order does not deadlock it',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId, S, 'running');
        await seedRun(taskId);

        const run = await interleave(
          () =>
            db.transaction(async (tx) => {
              await lockRun(R)(tx);
              await lockStepRow(S.id)(tx);
            }),
          runThenStepPeer,
          [S.id],
        );

        expectClean(run);
      },
      TEST_TIMEOUT,
    );

    it(
      'WS2: a writer that locks the step row and then the run holds the step row while it waits, and deadlocks with a peer that locks the run and then the step row',
      async () => {
        const taskId = await seedTask('running');
        await seedStep(taskId, S, 'running');
        await seedRun(taskId);

        const run = await interleave(
          () =>
            db.transaction(async (tx) => {
              await lockStepRow(S.id)(tx);
              await lockRun(R)(tx);
            }),
          runThenStepPeer,
          [S.id],
        );

        expect(
          run.heldWhileWaiting,
          'step rows the reverse-order writer held while it waited',
        ).toEqual([S.id]);
        // Postgres ends a two-party cycle by aborting exactly one side, whichever its detector reaches first.
        expect(run.failures, 'errors of the reverse-order writer and its peer').toHaveLength(1);
        expect(run.failures[0], 'the error that ended the cycle').toContain('40P01');
      },
      TEST_TIMEOUT,
    );

    // T459 item 1: requeueAbandonedOrphan, reached through recoverParkedStep.

    it(
      'W1: requeueAbandonedOrphan waits for the run of the abandoned step without holding the step row, so a Retry that locks the run and then the step row does not deadlock it',
      async () => {
        const taskId = await seedTask('running', { currentStepId: MOVED_ON, currentRound: 0 });
        await seedStep(taskId, S, 'waiting_cli', {
          startedAt: new Date(Date.now() - ORPHAN_AGE_MS),
        });
        await seedRun(taskId);
        const { orphan, deps, enqueueAdvance, queued } = abandonedOrphan(taskId);

        const run = await interleave(
          () => recoverParkedStep(db, orphan, queued, deps),
          runThenStepPeer,
          [S.id],
        );

        expectClean(run);
        expect(run.result, 'recoverParkedStep re-drove the step').toBe(false);
        expect(enqueueAdvance).not.toHaveBeenCalled();
        expect(await rowOf(S.id)).toMatchObject({
          status: 'pending',
          startedAt: null,
          waitingStartedAt: null,
        });
        const ended = await runOf(R);
        expect(ended.endedAt, 'ended_at of the run').not.toBeNull();
        expect(ended.supersededAt, 'superseded_at of the run').not.toBeNull();
        expect(ended.errorMessage).toBe(ABANDONED_RUN_MESSAGE);
      },
      TEST_TIMEOUT,
    );

    it('W1b: a step that is neither waiting_cli nor running keeps its open run', async () => {
      const taskId = await seedTask('running', { currentStepId: MOVED_ON, currentRound: 0 });
      await seedStep(taskId, S, 'done');
      await seedRun(taskId);
      const { orphan, deps, enqueueAdvance, queued } = abandonedOrphan(taskId);
      const before = { step: await rowOf(S.id), run: await runOf(R) };

      const redriven = await recoverParkedStep(db, orphan, queued, deps);

      expect(redriven, 'recoverParkedStep re-drove the step').toBe(false);
      expect(enqueueAdvance).not.toHaveBeenCalled();
      expect(await rowOf(S.id), 'the done step row').toEqual(before.step);
      const run = await runOf(R);
      expect(run, 'the open run').toEqual(before.run);
      expect(run).toMatchObject({ endedAt: null, supersededAt: null });
    });

    it('W1c: a waiting_cli step whose run already ended is still requeued and folded', async () => {
      const startedAt = new Date(Date.now() - ORPHAN_AGE_MS);
      const taskId = await seedTask('running', { currentStepId: MOVED_ON, currentRound: 0 });
      await seedStep(taskId, S, 'waiting_cli', {
        startedAt,
        idleMs: SEED.liveIdle,
        userActiveMs: SEED.liveUser,
        carriedWorkMs: SEED.work,
        carriedIdleMs: SEED.idle,
        carriedUserActiveMs: SEED.user,
      });
      await seedRun(taskId, {
        startedAt,
        endedAt: new Date(startedAt.getTime() + 60_000),
        exitCode: 0,
      });
      const { orphan, deps, enqueueAdvance, queued } = abandonedOrphan(taskId);
      const runBefore = await runOf(R);

      const before = Date.now();
      const redriven = await recoverParkedStep(db, orphan, queued, deps);
      const after = Date.now();

      expect(redriven, 'recoverParkedStep re-drove the step').toBe(false);
      expect(enqueueAdvance).not.toHaveBeenCalled();
      const row = await rowOf(S.id);
      expect(row).toMatchObject({
        status: 'pending',
        startedAt: null,
        waitingStartedAt: null,
        idleMs: 0,
        userActiveMs: 0,
      });
      // The row's span is still open (its ended_at is null), so all of it folds into idle and none into work.
      expect(row.carriedWorkMs, 'carried work after the fold').toBe(SEED.work);
      expect(row.carriedUserActiveMs, 'carried user-active time after the fold').toBe(
        SEED.user + SEED.liveUser,
      );
      expect(row.carriedIdleMs, 'carried idle after the fold').toBeGreaterThanOrEqual(
        SEED.idle + (before - startedAt.getTime()),
      );
      expect(row.carriedIdleMs, 'carried idle after the fold').toBeLessThanOrEqual(
        SEED.idle + (after - startedAt.getTime()),
      );
      expect(await runOf(R), 'the run that had already ended').toEqual(runBefore);
    });

    // ReopenStepForm: the reopened form's hold and the consumed agent rows.

    it.each([undefined, 1])(
      'W2: new generation %s: holdReopenedForm waits for the agent rows without holding the step row, so a Retry that locks an agent row and then the step row does not deadlock it',
      async (nextGeneration) => {
        const taskId = await seedTask('running');
        await seedStep(taskId, S, 'running', { ...OPEN_FORM, pauseFormOnRetry: false });
        await seedMining();

        const run = await interleave(
          () => holdReopenedForm(db, S.id, [reopenedAgent()], AT, nextGeneration),
          miningThenStepPeer,
          [S.id],
        );

        expectClean(run);
        expect(await rowOf(S.id)).toMatchObject({
          status: 'running',
          detectOutput: null,
          formSchema: null,
          formValues: null,
          pauseFormOnRetry: true,
          rerunGeneration: nextGeneration ?? 0,
        });
        expect((await miningOf(M)).consumedAt, 'consumed_at of the agent row').toEqual(AT);
      },
      TEST_TIMEOUT,
    );

    it.each([undefined, 1])(
      'W2b: new generation %s: a pass that no longer owns the step row is refused, and the agent rows stay unconsumed',
      async (nextGeneration) => {
        const taskId = await seedTask('running');
        await seedStep(taskId, S, 'pending', { ...OPEN_FORM, pauseFormOnRetry: false });
        await seedMining();
        const before = { step: await rowOf(S.id), mining: await miningOf(M) };

        const refused = await settle(
          holdReopenedForm(db, S.id, [reopenedAgent()], AT, nextGeneration),
        );

        expect(refused.ok, 'holdReopenedForm resolved for a pass that does not own the row').toBe(
          false,
        );
        expect(refused.ok ? undefined : refused.error).toBeInstanceOf(StepSupersededError);
        expect(await rowOf(S.id), 'the step row the Retry reset').toEqual(before.step);
        const mining = await miningOf(M);
        expect(mining.consumedAt, 'consumed_at of the agent row').toBeNull();
        expect(mining, 'the agent row').toEqual(before.mining);
      },
    );

    it.each([1, 2])(
      'W2d: concurrent Retry generation %s supersedes a stale new-attempt hold without repeating or lowering it',
      async (generation) => {
        const taskId = await seedTask('running');
        await seedStep(taskId, S, 'running', { ...OPEN_FORM, pauseFormOnRetry: false });
        await seedMining();
        const before = await rowOf(S.id);
        const run = await interleave(
          () => settle(holdReopenedForm(db, S.id, [reopenedAgent()], AT, 1)),
          {
            first: lockMining(M),
            second: async (tx) => {
              // A Retry and its next pass can leave the same status but a newer identity.
              await tx
                .update(schema.taskSteps)
                .set({ rerunGeneration: generation, status: 'running' })
                .where(eq(schema.taskSteps.id, S.id));
            },
          },
          [S.id],
        );
        expectClean(run);
        expect(run.result?.ok, 'the stale hold must supersede').toBe(false);
        expect(run.result?.ok ? undefined : run.result?.error).toBeInstanceOf(StepSupersededError);
        expect(await rowOf(S.id)).toEqual({ ...before, rerunGeneration: generation });
        expect(
          (await miningOf(M)).consumedAt,
          'consumption rolls back with the stale hold',
        ).toBeNull();
      },
      TEST_TIMEOUT,
    );

    it('W2c: a reopened insight batch accepts a different manual selection and retains the prior outcome', async () => {
      const taskId = await seedTask('running');
      await seedStep(taskId, S, 'running', OPEN_FORM);
      await seedMining();
      const ctx = {
        db,
        taskId,
        taskStepId: S.id,
        userId,
        epoch: EPOCH,
        rerunGeneration: 0,
        throwIfCancelled() {},
      } as StepContext;
      const one = {
        id: 'one',
        identity: 'a.ts::one',
        legacyId: 'i-1',
        picked: false,
        sourceStep: 'review',
        title: 'One',
        location: 'a.ts',
        description: 'Repair',
      };
      const two = { ...one, id: 'two', identity: 'b.ts::two', title: 'Two', location: 'b.ts' };
      const automatic = await ensureInsightIntent(ctx, [one], 'auto_08e');
      await appendInsightBatch(ctx, {
        ...automatic,
        stage: 'outcome',
        items: [
          {
            id: one.id,
            outcome: 'not_applied',
            changes: [],
            reason: 'Requires a decision',
          },
        ],
      });
      await holdReopenedForm(db, S.id, [reopenedAgent()], AT, 1);
      ctx.rerunGeneration = 1;
      const manual = await ensureInsightIntent(ctx, [two]);
      expect(manual).toMatchObject({
        mode: 'manual_08e',
        generation: 1,
        selected: [{ id: two.id }],
      });
      expect(manual.batchId).not.toBe(automatic.batchId);
      expect(await ensureInsightIntent(ctx, [two])).toEqual(manual);
      const records = await loadInsightBatchRecords(db, taskId);
      expect(records).toHaveLength(3);
      expect(
        records.find((r) => r.batchId === automatic.batchId && r.stage === 'outcome')!.items,
      ).toMatchObject([{ id: one.id, outcome: 'not_applied' }]);
      expect((await miningOf(M)).consumedAt).toEqual(AT);
    });

    // T459 item 4(a): the CANCEL job's step sweep, one autocommit UPDATE in scan order.

    it(
      'W3: the CANCEL job sweeps the open step rows without holding the higher one while it waits for the lower, so an id-ordered batch does not deadlock it',
      async () => {
        const taskId = await seedTask('cancelled', { completedAt: T0 });
        await seedAB(taskId, 'running', 'waiting_form');

        const run = await interleave(() => runCancel(taskId), idOrderedPeer, [B.id]);

        expectClean(run);
        const rows = await stepsOf(taskId);
        expect(rows.map((row) => row.id).sort()).toEqual([A.id, B.id]);
        for (const row of rows) {
          expect(row, `step row ${NAMES[row.id]}`).toMatchObject({
            status: 'failed',
            errorMessage: CANCELLED,
          });
          expect(row.endedAt?.getTime() ?? 0, `ended_at of ${NAMES[row.id]}`).toBeGreaterThan(
            T0.getTime(),
          );
        }
      },
      TEST_TIMEOUT,
    );

    it('W3b: the CANCEL job leaves step rows that are already failed untouched', async () => {
      const taskId = await seedTask('cancelled', { completedAt: T0 });
      await seedAB(taskId, 'failed', 'failed', { errorMessage: STOPPED, endedAt: T0 });
      const before = await stepsOf(taskId);

      const ended = await settle(runCancel(taskId));

      expect(describeOutcome(ended), 'the job').toBe('resolved');
      expect(await stepsOf(taskId), 'step rows').toEqual(before);
    });
  },
);
