import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import {
  backfillMissingRunSeq,
  processTaskJob,
  reconcileOrphanedSteps,
} from '../src/queues/task-queue.js';
import { reconcileDeadTasks, type DeadTaskBootDeps } from '../src/queues/dead-task-boot.js';
import { redriveStalledTasks, type StalledRedriveDeps } from '../src/queues/stalled-redrive.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: unknown }[],
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
    async add(name: string, data: unknown) {
      h.adds.push({ name, data });
    }
  },
}));

const url = process.env.STOP_FAILED_ROW_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/stop_failed_row_test'))
  throw new Error('Use a dedicated stop_failed_row_test database for stop failed row tests');

const TYPE = 'fnf262_stop_failed_row';
const S = '01-debug-mode';
const NEXT = '00-triage';
const E = 3;
const ROUND = 1;
const STOPPED = 'Stopped by user';
const OLD = new Date('2026-10-20T10:00:00.000Z');

const calls = { detect: 0, form: 0, shouldRun: 0, apply: 0 };
const total = () => calls.detect + calls.form + calls.shouldRun + calls.apply;

function stub(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'workflow' as WorkflowType,
      index,
      title: id,
      description: 'stop-failed-row test stub',
      requiresCli: false,
    },
    async detect() {
      calls.detect++;
      return {};
    },
    form() {
      calls.form++;
      return { title: id, fields: [] };
    },
    shouldRun() {
      calls.shouldRun++;
      return true;
    },
    async apply() {
      calls.apply++;
      return {};
    },
  } as StepDefinition;
}

describe.skipIf(!url)('the worker leaves a Stop-failed row alone, on Postgres', () => {
  const EMAIL_INDEX = 'stop-failed-row-test-user';
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

  const makeTask = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: TYPE,
        title: 'stop failed row',
        status: 'failed',
        errorMessage: STOPPED,
        completedAt: OLD,
        orchestrationEpoch: E,
        currentStepId: S,
        currentRound: ROUND,
        runListSnapshot: [S, NEXT],
        createdAt: OLD,
        updatedAt: OLD,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    return made!.id;
  };
  const makeRow = async (
    taskId: string,
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const [made] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: S,
        stepIndex: 1,
        round: ROUND,
        title: S,
        status: 'failed',
        errorMessage: STOPPED,
        endedAt: OLD,
        startedAt: null,
        waitingStartedAt: null,
        runSeq: 0,
        createdAt: OLD,
        updatedAt: OLD,
        ...over,
      })
      .returning({ id: schema.taskSteps.id });
    return made!.id;
  };
  const stopped = async () => {
    const taskId = await makeTask();
    await makeRow(taskId);
    return taskId;
  };

  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const state = async (taskId: string) => ({
    task: plain((await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!),
    steps: plain(
      await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId)),
    ),
    events: plain(
      await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId)),
    ),
    runs: plain(
      await db.select().from(schema.cliInvocations).where(eq(schema.cliInvocations.taskId, taskId)),
    ),
  });
  const expectUntouched = async (taskId: string, before: Awaited<ReturnType<typeof state>>) => {
    expect(await state(taskId)).toEqual(before);
    expect(total()).toBe(0);
    expect(h.adds).toEqual([]);
  };

  const spyDeps = () => {
    const spy = { advance: 0, fail: 0, start: 0 };
    const deps: StalledRedriveDeps = {
      enqueueAdvance: async () => {
        spy.advance++;
      },
      failTask: async () => {
        spy.fail++;
        return true;
      },
      enqueueStart: async () => {
        spy.start++;
      },
      queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
      queuedInvocationIds: async () => new Set<string>(),
    };
    return { spy, deps };
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'stop-failed-row-test@test.local',
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
        name: 'stop-failed-row',
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
    stepRegistry.override(stub(NEXT, 2));
  });

  beforeEach(async () => {
    h.adds.length = 0;
    calls.detect = calls.form = calls.shouldRun = calls.apply = 0;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe('a job that reaches the task', () => {
    const ADVANCES: [string, (taskId: string) => Record<string, unknown>][] = [
      ['at the epoch the Stop left', (taskId) => ({ taskId, stepId: S, round: ROUND, epoch: E })],
      ['at a stale epoch', (taskId) => ({ taskId, stepId: S, round: ROUND, epoch: E - 1 })],
      ['with no epoch', (taskId) => ({ taskId, stepId: S, round: ROUND })],
      [
        'carrying form values',
        (taskId) => ({ taskId, stepId: S, round: ROUND, epoch: E, formValues: { x: 1 } }),
      ],
      ['for another round', (taskId) => ({ taskId, stepId: S, round: ROUND + 1, epoch: E })],
      ['for another step', (taskId) => ({ taskId, stepId: NEXT, round: 0, epoch: E })],
    ];

    it.each(ADVANCES)('an advance %s changes nothing', async (_name, data) => {
      const taskId = await stopped();
      const before = await state(taskId);
      await processTaskJob(job(TASK_JOB_NAMES.ADVANCE_STEP, { userId, ...data(taskId) }));
      await expectUntouched(taskId, before);
    });

    it('a START changes nothing', async () => {
      const taskId = await stopped();
      const before = await state(taskId);
      await processTaskJob(job(TASK_JOB_NAMES.START, { taskId, userId }));
      await expectUntouched(taskId, before);
    });
  });

  describe('the stalled-task sweep', () => {
    it('takes nothing, calls nothing and keeps the epoch over three passes', async () => {
      const taskId = await stopped();
      const before = await state(taskId);
      const { spy, deps } = spyDeps();
      for (let pass = 0; pass < 3; pass++) {
        await expect(redriveStalledTasks(db, deps, { staleMs: 0 })).resolves.toBe(0);
        expect(spy).toEqual({ advance: 0, fail: 0, start: 0 });
        expect((await state(taskId)).task.orchestrationEpoch).toBe(E);
      }
      await expectUntouched(taskId, before);
    });
  });

  describe('the boot passes', () => {
    it('reconcileOrphanedSteps changes nothing', async () => {
      const taskId = await stopped();
      const before = await state(taskId);
      const advances: unknown[] = [];
      await reconcileOrphanedSteps(db, {
        enqueueAdvance: async (...args) => {
          advances.push(args);
        },
        queuedInvocationIds: async () => new Set<string>(),
      });
      expect(advances).toEqual([]);
      await expectUntouched(taskId, before);
    });

    it('reconcileDeadTasks judges the task and changes nothing', async () => {
      const taskId = await stopped();
      const before = await state(taskId);
      const sent: string[] = [];
      const deps: DeadTaskBootDeps = {
        enqueueStart: async () => {
          sent.push('start');
        },
        enqueueAdvance: async () => {
          sent.push('advance');
        },
        redriveRetryDelaysMs: [],
      };
      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({
        marked: 0,
        revived: 0,
        failed: 0,
      });
      expect(sent).toEqual([]);
      await expectUntouched(taskId, before);
    });

    it('backfillMissingRunSeq changes nothing', async () => {
      const taskId = await stopped();
      const before = await state(taskId);
      await backfillMissingRunSeq(db);
      await expectUntouched(taskId, before);
    });
  });

  describe('negative controls: the same entry points do act on a task that is not Stop-failed', () => {
    it('the sweep re-drives a running task whose current row is pending', async () => {
      const taskId = await makeTask({ status: 'running', errorMessage: null, completedAt: null });
      await makeRow(taskId, { status: 'pending', errorMessage: null, endedAt: null });
      const { spy, deps } = spyDeps();
      await expect(redriveStalledTasks(db, deps, { staleMs: 0 })).resolves.toBe(1);
      expect(spy).toEqual({ advance: 1, fail: 0, start: 0 });
      expect((await state(taskId)).task.orchestrationEpoch).toBe(E + 1);
    });

    it('a START claims a task that is queued', async () => {
      const taskId = await makeTask({
        status: 'queued',
        errorMessage: null,
        completedAt: null,
        currentStepId: null,
        currentRound: 0,
      });
      await processTaskJob(job(TASK_JOB_NAMES.START, { taskId, userId }));
      const after = await state(taskId);
      expect(after.task.status).not.toBe('queued');
      expect(after.task.orchestrationEpoch).toBe(E);
      expect(total()).toBeGreaterThan(0);
    });

    it('an advance at the epoch runs the step of a running task with a pending row', async () => {
      const taskId = await makeTask({ status: 'running', errorMessage: null, completedAt: null });
      await makeRow(taskId, { status: 'pending', errorMessage: null, endedAt: null });
      await processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: S, round: ROUND, epoch: E }),
      );
      expect(calls.detect).toBe(1);
      expect((await state(taskId)).steps[0]!.status).not.toBe('pending');
    });
  });
});
