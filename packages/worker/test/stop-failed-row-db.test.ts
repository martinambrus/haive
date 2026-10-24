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
  releases: [] as string[],
  admission: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('../src/sandbox/runtime-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/runtime-admission.js')>()),
  runtimeAdmission: async () => {
    await h.admission?.();
    return { decision: 'proceed', busyMb: 0, budgetMb: 0, myWeightMb: 0, position: 1, waiting: 0 };
  },
  releaseRuntimeReservation: async (taskId: string) => {
    h.releases.push(taskId);
  },
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

const R = '02-runtime-step';
const hook = { apply: undefined as undefined | (() => Promise<void>) };
const calls = { detect: 0, form: 0, shouldRun: 0, apply: 0 };
const total = () => calls.detect + calls.form + calls.shouldRun + calls.apply;

function stub(id: string, index: number, needsRuntime?: 'app'): StepDefinition {
  return {
    ...(needsRuntime ? { needsRuntime } : {}),
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
      if (id === S) await hook.apply?.();
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
    stepRegistry.override(stub(R, 3, 'app'));
  });

  beforeEach(async () => {
    h.adds.length = 0;
    h.releases.length = 0;
    h.admission = undefined;
    hook.apply = undefined;
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

  describe('a pass in flight when a Stop commits', () => {
    const stepFailedEvents = async (taskId: string) =>
      (await state(taskId)).events.filter((e) => e.eventType === 'step.failed');
    const runPass = (taskId: string) =>
      processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: S, round: ROUND, epoch: E }),
      );
    const running = async () => {
      const taskId = await makeTask({ status: 'running', errorMessage: null, completedAt: null });
      await makeRow(taskId, { status: 'pending', errorMessage: null, endedAt: null });
      return taskId;
    };

    it('leaves the Stop error, completed_at and the single step.failed alone', async () => {
      const taskId = await running();
      hook.apply = async () => {
        await db
          .update(schema.tasks)
          .set({ status: 'failed', errorMessage: STOPPED, completedAt: OLD })
          .where(eq(schema.tasks.id, taskId));
        await db
          .insert(schema.taskEvents)
          .values({ taskId, eventType: 'step.failed', payload: { error: STOPPED } });
        throw new Error('the pass failed after the Stop');
      };
      await runPass(taskId);
      expect(calls.apply).toBe(1);
      const after = await state(taskId);
      expect(after.task.status).toBe('failed');
      expect(after.task.errorMessage).toBe(STOPPED);
      expect(after.task.completedAt).toBe(OLD.toISOString());
      expect(await stepFailedEvents(taskId)).toHaveLength(1);
    });

    it('still fails a task nobody stopped, once', async () => {
      const taskId = await running();
      hook.apply = async () => {
        throw new Error('the pass failed on its own');
      };
      await runPass(taskId);
      const after = await state(taskId);
      expect(after.task.status).toBe('failed');
      expect(after.task.errorMessage).toContain('the pass failed on its own');
      expect(after.task.completedAt).not.toBe(OLD.toISOString());
      expect(await stepFailedEvents(taskId)).toHaveLength(1);
    });
  });

  describe('the runtime slot of an admitted step', () => {
    const runR = (taskId: string) =>
      processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: R, round: 0, epoch: E }),
      );
    const taskOnR = async () => {
      const taskId = await makeTask({
        status: 'running',
        errorMessage: null,
        completedAt: null,
        currentStepId: R,
        currentRound: 0,
        runListSnapshot: [S, NEXT, R],
      });
      await makeRow(taskId, {
        stepId: R,
        stepIndex: 3,
        round: 0,
        status: 'pending',
        errorMessage: null,
        endedAt: null,
      });
      return taskId;
    };

    it.each([
      [
        'a Retry',
        (taskId: string) =>
          db
            .update(schema.tasks)
            .set({ orchestrationEpoch: E + 1 })
            .where(eq(schema.tasks.id, taskId)),
      ],
      [
        'a Stop',
        (taskId: string) =>
          db
            .update(schema.tasks)
            .set({ status: 'failed', errorMessage: STOPPED, completedAt: OLD })
            .where(eq(schema.tasks.id, taskId)),
      ],
    ])('is released once when %s overtakes the step at the fence', async (_name, overtake) => {
      const taskId = await taskOnR();
      h.admission = async () => {
        await overtake(taskId);
      };
      await runR(taskId);
      expect(calls.apply).toBe(0);
      expect(h.releases).toEqual([taskId]);
    });

    it('is released once when the step runs normally', async () => {
      const taskId = await taskOnR();
      await runR(taskId);
      expect(calls.apply).toBe(1);
      expect(h.releases).toEqual([taskId]);
    });
  });

  describe('a job that throws out of the queue handler', () => {
    const boom = 'the job threw';
    const runR = (taskId: string) =>
      processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: R, round: 0, epoch: E }),
      );
    const taskOnR = async () => {
      const taskId = await makeTask({
        status: 'running',
        errorMessage: null,
        completedAt: null,
        currentStepId: R,
        currentRound: 0,
        runListSnapshot: [S, NEXT, R],
      });
      await makeRow(taskId, {
        stepId: R,
        stepIndex: 3,
        round: 0,
        status: 'pending',
        errorMessage: null,
        endedAt: null,
      });
      return taskId;
    };

    it('leaves the Stop error and completed_at alone', async () => {
      const taskId = await taskOnR();
      h.admission = async () => {
        await db
          .update(schema.tasks)
          .set({ status: 'failed', errorMessage: STOPPED, completedAt: OLD })
          .where(eq(schema.tasks.id, taskId));
        throw new Error(boom);
      };
      await expect(runR(taskId)).rejects.toThrow(boom);
      const after = (await state(taskId)).task;
      expect(after.status).toBe('failed');
      expect(after.errorMessage).toBe(STOPPED);
      expect(after.completedAt).toBe(OLD.toISOString());
    });

    it('still fails a running task with the thrown message', async () => {
      const taskId = await taskOnR();
      h.admission = async () => {
        throw new Error(boom);
      };
      await expect(runR(taskId)).rejects.toThrow(boom);
      const after = (await state(taskId)).task;
      expect(after.status).toBe('failed');
      expect(after.errorMessage).toContain(boom);
      expect(after.completedAt).not.toBe(OLD.toISOString());
    });
  });

  describe('a START that throws before it claims the task', () => {
    const boom = 'the run list threw';
    const failStart = () =>
      vi.spyOn(stepRegistry, 'get').mockImplementation(() => {
        throw new Error(boom);
      });
    const queued = () =>
      makeTask({
        status: 'queued',
        errorMessage: null,
        completedAt: null,
        currentStepId: null,
        currentRound: 0,
      });

    it('fails a queued task with the thrown message', async () => {
      const taskId = await queued();
      const spy = failStart();
      await expect(processTaskJob(job(TASK_JOB_NAMES.START, { taskId, userId }))).rejects.toThrow(
        boom,
      );
      spy.mockRestore();
      const after = (await state(taskId)).task;
      expect(after.status).toBe('failed');
      expect(after.errorMessage).toContain(boom);
    });

    it('leaves a Stop-failed task alone', async () => {
      const taskId = await stopped();
      const before = await state(taskId);
      const spy = failStart();
      await processTaskJob(job(TASK_JOB_NAMES.START, { taskId, userId })).catch(() => undefined);
      spy.mockRestore();
      expect((await state(taskId)).task).toEqual(before.task);
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
