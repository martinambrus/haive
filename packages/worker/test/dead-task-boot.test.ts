import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import {
  handleResult,
  markTaskDead,
  processTaskJob,
  reconcileOrphanedSteps,
  resolveFixLoopGate,
} from '../src/queues/task-queue.js';
import {
  reconcileDeadTasks,
  reviveDeadTask,
  type DeadTaskBootDeps,
  type DeadTaskView,
} from '../src/queues/dead-task-boot.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import type { AdvanceStepResult } from '../src/step-engine/index.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../src/step-engine/steps/workflow/_fix-loop.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  /** What the task queue was asked to enqueue. */
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

const url = process.env.DEAD_TASK_BOOT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/dead_task_boot_test'))
  throw new Error('Use a dedicated dead_task_boot_test database for dead task boot tests');

const TYPE = 'j4a_dead_boot';
const DYNAMIC = 'fnf136_dead_boot_dynamic';
const LOOP_TYPE = 'fnf137_loop_back';
const A = 'j4a-a';
const B = 'j4a-b';
const REVIEW = 'fnf137-review';
const REVISER = 'fnf137-reviser';
const GONE = 'module.j4a.gone';
const LATER = 'module.j4a.later';
const DEAD_AT = new Date('2026-10-14T08:00:00.000Z');
const DEAD_REASON = `the run list names a step this install does not register: ${GONE}`;

type StepRow = typeof schema.taskSteps.$inferSelect;

function stub(
  id: string,
  index: number,
  workflowType: string = TYPE,
  over: Partial<StepDefinition> = {},
): void {
  stepRegistry.register({
    metadata: {
      id,
      workflowType: workflowType as WorkflowType,
      index,
      title: id,
      description: 'dead-task-boot test stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return { title: id, fields: [] };
    },
    async apply() {
      return {};
    },
    ...over,
  });
}

interface Sent {
  kind: 'start' | 'advance';
  taskId: string;
  stepId?: string;
  round?: number;
  epoch?: number;
}

function recorder(failFor?: string) {
  const sent: Sent[] = [];
  const deps: DeadTaskBootDeps = {
    enqueueStart: async (taskId) => {
      sent.push({ kind: 'start', taskId });
    },
    enqueueAdvance: async (taskId, _userId, stepId, round, epoch) => {
      if (taskId === failFor) throw new Error('queue refused the job');
      sent.push({ kind: 'advance', taskId, stepId, round, epoch });
    },
    redriveRetryDelaysMs: [],
  };
  return { sent, deps };
}

describe.skipIf(!url)('dead tasks at worker boot, on Postgres', () => {
  const EMAIL_INDEX = 'dead-task-boot-test-user';
  let db: Database;
  let userId: string;

  const make = async (over: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<string> => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: TYPE,
        title: 'dead task boot',
        status: 'running',
        orchestrationEpoch: 3,
        currentStepId: A,
        currentRound: 0,
        runListSnapshot: [A, B],
        ...over,
      })
      .returning({ id: schema.tasks.id });
    return task!.id;
  };
  const makeDead = (over: Partial<typeof schema.tasks.$inferInsert> = {}) =>
    make({ deadAt: DEAD_AT, deadReason: DEAD_REASON, ...over });
  const row = async (
    taskId: string,
    stepId: string,
    status: (typeof schema.taskSteps.$inferInsert)['status'],
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const [made] = await db
      .insert(schema.taskSteps)
      .values({ taskId, stepId, stepIndex: 1, round: 0, title: stepId, status, ...over })
      .returning();
    return made!;
  };
  const run = async (
    taskId: string,
    taskStepId: string | null,
    over: Partial<typeof schema.cliInvocations.$inferInsert> = {},
  ) => {
    const [made] = await db
      .insert(schema.cliInvocations)
      .values({ taskId, taskStepId, mode: 'cli', prompt: 'dead-task-boot', ...over })
      .returning();
    return made!;
  };
  const task = async (id: string) => {
    const [found] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    return found!;
  };
  const view = async (id: string): Promise<DeadTaskView> => {
    const t = await task(id);
    return {
      id: t.id,
      userId: t.userId,
      epoch: t.orchestrationEpoch,
      currentStepId: t.currentStepId,
      currentRound: t.currentRound,
      deadAt: t.deadAt,
      deadReason: t.deadReason,
    };
  };
  const events = (id: string, type?: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(
        type
          ? and(eq(schema.taskEvents.taskId, id), eq(schema.taskEvents.eventType, type))
          : eq(schema.taskEvents.taskId, id),
      )
      .orderBy(asc(schema.taskEvents.createdAt));
  const stepRow = async (id: string) => {
    const [found] = await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, id));
    return found!;
  };
  const runOf = async (id: string) => {
    const [found] = await db
      .select()
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, id));
    return found!;
  };
  const ctxFor = (
    taskId: string,
    snapshot: string[],
    over: Partial<ResolvedTaskContext> = {},
  ): ResolvedTaskContext => ({
    taskId,
    userId,
    workflowType: TYPE as WorkflowType,
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: null,
    ignoreSavedStepClis: false,
    executionPath: null,
    metadata: null,
    orchestrationEpoch: 3,
    currentStepId: A,
    currentRound: 0,
    status: 'running',
    completedAt: null,
    runListStrategy: 'static',
    runListSnapshot: snapshot,
    fixLoop: null,
    ...over,
  });
  let repositoryId: string;
  const job = (name: string, data: Record<string, unknown>) =>
    ({
      id: randomUUID(),
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'dead-task-boot-test@test.local',
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
        name: 'dead-task-boot',
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
    await db
      .insert(schema.taskTypeDefinitions)
      .values({
        slug: DYNAMIC,
        displayName: DYNAMIC,
        runListStrategy: 'workflow_paths',
        source: 'test',
      })
      .onConflictDoNothing();
    stub(A, 1);
    stub(B, 2);
    stub(FIX_LOOP_TARGET_STEP_ID, 0, LOOP_TYPE);
    stub(REVIEW, 1, LOOP_TYPE, {
      fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'the review found a defect' }) },
    });
    stub(REVISER, 2, LOOP_TYPE, {
      reviseLoop: { evaluate: () => ({ targetStepId: FIX_LOOP_TARGET_STEP_ID }) },
    });
  });

  beforeEach(async () => {
    h.adds.length = 0;
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, [TYPE, DYNAMIC]));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    await db.$client.end({ timeout: 5 });
  });

  describe('a dead task whose run list resolves again', () => {
    const CASES = [
      { status: 'queued', current: null, row: null, job: 'start' },
      { status: 'running', current: A, row: null, job: 'advance' },
      {
        status: 'waiting_user',
        current: A,
        row: { status: 'waiting_form', waitingStartedAt: null, formValues: { ok: true } },
        job: 'advance',
      },
      {
        status: 'waiting_user',
        current: A,
        row: { status: 'waiting_form', waitingStartedAt: DEAD_AT, formValues: null },
        job: 'none',
      },
      { status: 'created', current: null, row: null, job: 'none' },
      {
        status: 'waiting_pr',
        current: A,
        row: { status: 'waiting_form', waitingStartedAt: DEAD_AT, formValues: null },
        job: 'none',
      },
      { status: 'failed', current: A, row: { status: 'failed' }, job: 'none' },
    ] as const;

    it.each(CASES)('is revived from $status and gets the $job job', async (c) => {
      const id = await makeDead({ status: c.status, currentStepId: c.current, currentRound: 1 });
      if (c.row) await row(id, A, c.row.status, { round: 1, ...c.row });
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ revived: 1 });

      const t = await task(id);
      expect(t).toMatchObject({
        deadAt: null,
        deadReason: null,
        status: c.status,
        orchestrationEpoch: 4,
        currentStepId: c.current,
        currentRound: 1,
      });
      const expected: Sent[] =
        c.job === 'start'
          ? [{ kind: 'start', taskId: id }]
          : c.job === 'advance'
            ? [{ kind: 'advance', taskId: id, stepId: A, round: 1, epoch: 4 }]
            : [];
      expect(sent).toEqual(expected);
      const revived = await events(id, 'task.revived');
      expect(revived).toHaveLength(1);
      expect(revived[0]?.payload).toMatchObject({ epoch: 4, action: c.job });
    });

    it('walks a finished step on without writing a second step.done or touching its row', async () => {
      const id = await makeDead();
      const done = await row(id, A, 'done', {
        output: { kept: true },
        endedAt: DEAD_AT,
        updatedAt: DEAD_AT,
      });
      await db
        .insert(schema.taskEvents)
        .values({ taskId: id, taskStepId: done.id, eventType: 'step.done', payload: {} });
      const { sent, deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(sent).toEqual([{ kind: 'advance', taskId: id, stepId: A, round: 0, epoch: 4 }]);
      expect(await stepRow(done.id)).toEqual(done);
      expect(await events(id, 'step.done')).toHaveLength(1);
    });

    it('leaves a saved answer and the park marker as they were', async () => {
      const answered = await makeDead({ status: 'waiting_user' });
      const answeredRow = await row(answered, A, 'waiting_form', {
        waitingStartedAt: null,
        formValues: { picked: 'x' },
        updatedAt: DEAD_AT,
      });
      const awaiting = await makeDead({ status: 'waiting_user', currentStepId: B });
      const awaitingRow = await row(awaiting, B, 'waiting_form', {
        waitingStartedAt: DEAD_AT,
        updatedAt: DEAD_AT,
      });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await stepRow(answeredRow.id)).toEqual(answeredRow);
      expect(await stepRow(awaitingRow.id)).toEqual(awaitingRow);
    });

    it('is revived once the step it names is registered again, and not before', async () => {
      const id = await makeDead({ runListSnapshot: [A, LATER] });
      const before = await task(id);
      const first = recorder();

      await expect(reconcileDeadTasks(db, first.deps)).resolves.toMatchObject({
        marked: 0,
        revived: 0,
      });
      expect(await task(id)).toEqual(before);
      expect(await events(id)).toHaveLength(0);
      expect(first.sent).toEqual([]);

      stub(LATER, 3);
      const second = recorder();
      await expect(reconcileDeadTasks(db, second.deps)).resolves.toMatchObject({ revived: 1 });
      expect(await task(id)).toMatchObject({ deadAt: null, orchestrationEpoch: 4 });
      expect(second.sent).toEqual([{ kind: 'advance', taskId: id, stepId: A, round: 0, epoch: 4 }]);
    });

    it('stays dead while a step it names is still missing', async () => {
      const id = await makeDead({ runListSnapshot: [A, GONE] });
      const before = await task(id);
      const { sent, deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await task(id)).toEqual(before);
      expect(await events(id)).toHaveLength(0);
      expect(sent).toEqual([]);
    });

    it('stays dead while its current step lies outside a static run list', async () => {
      const id = await makeDead({ runListSnapshot: [B], currentStepId: A });
      const before = await task(id);
      const { sent, deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await task(id)).toEqual(before);
      expect(sent).toEqual([]);
    });

    it.each(['cancelled', 'completed'] as const)(
      'stays %s, and dead as history',
      async (status) => {
        const id = await makeDead({ status });
        const before = await task(id);
        const { sent, deps } = recorder();

        await reconcileDeadTasks(db, deps);

        expect(await task(id)).toEqual(before);
        expect(await events(id)).toHaveLength(0);
        expect(sent).toEqual([]);
      },
    );

    it('writes nothing on a second run', async () => {
      const id = await makeDead();
      const first = recorder();
      await reconcileDeadTasks(db, first.deps);
      const after = await task(id);
      const afterEvents = await events(id);

      const second = recorder();
      await expect(reconcileDeadTasks(db, second.deps)).resolves.toMatchObject({
        marked: 0,
        revived: 0,
      });

      expect(await task(id)).toEqual(after);
      expect(await events(id)).toEqual(afterEvents);
      expect(second.sent).toEqual([]);
    });

    it('queues one job when two runs race for the same task', async () => {
      const id = await makeDead();
      const { sent, deps } = recorder();

      await Promise.all([reconcileDeadTasks(db, deps), reconcileDeadTasks(db, deps)]);

      expect(sent).toEqual([{ kind: 'advance', taskId: id, stepId: A, round: 0, epoch: 4 }]);
      expect((await task(id)).orchestrationEpoch).toBe(4);
      expect(await events(id, 'task.revived')).toHaveLength(1);
    });

    it('puts the dead state back when its job cannot be queued, and goes on to the next task', async () => {
      const refused = await makeDead();
      const fine = await makeDead();
      const { sent, deps } = recorder(refused);

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ revived: 1 });

      expect(await task(refused)).toMatchObject({
        deadAt: DEAD_AT,
        deadReason: DEAD_REASON,
        orchestrationEpoch: 4,
      });
      expect(await task(fine)).toMatchObject({ deadAt: null, orchestrationEpoch: 4 });
      expect(sent).toEqual([{ kind: 'advance', taskId: fine, stepId: A, round: 0, epoch: 4 }]);
    });

    it('carries the unresolved ids of the last task.dead event into task.revived', async () => {
      const id = await makeDead();
      await db.insert(schema.taskEvents).values({
        taskId: id,
        eventType: 'task.dead',
        payload: { reason: DEAD_REASON, unresolved: [GONE], epoch: 3 },
      });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      const [revived] = await events(id, 'task.revived');
      expect(revived?.payload).toMatchObject({ unresolved: [GONE], action: 'advance' });
    });
  });

  describe('the revive fence', () => {
    it('refuses a task that moved to another epoch since it was read', async () => {
      const id = await makeDead();
      const read = await view(id);
      const { sent, deps } = recorder();

      await expect(
        reviveDeadTask(db, { ...read, epoch: read.epoch - 1 }, deps),
      ).resolves.toBeNull();

      expect(await task(id)).toMatchObject({ deadAt: DEAD_AT, orchestrationEpoch: 3 });
      expect(sent).toEqual([]);
    });

    it.each(['cancelled', 'completed'] as const)(
      'refuses a task that became %s at the same epoch',
      async (status) => {
        const id = await makeDead();
        const read = await view(id);
        await db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
        const { sent, deps } = recorder();

        await expect(reviveDeadTask(db, read, deps)).resolves.toBeNull();

        expect(await task(id)).toMatchObject({ status, deadAt: DEAD_AT, orchestrationEpoch: 3 });
        expect(await events(id)).toHaveLength(0);
        expect(sent).toEqual([]);
      },
    );

    it('refuses a task that points at another step or round than the one it was read at', async () => {
      const id = await makeDead();
      const read = await view(id);
      const { sent, deps } = recorder();

      await expect(reviveDeadTask(db, { ...read, currentStepId: B }, deps)).resolves.toBeNull();
      await expect(reviveDeadTask(db, { ...read, currentRound: 2 }, deps)).resolves.toBeNull();

      expect(await task(id)).toMatchObject({ deadAt: DEAD_AT, orchestrationEpoch: 3 });
      expect(sent).toEqual([]);
    });

    it('refuses a task that is not dead', async () => {
      const id = await make();
      const read = await view(id);
      const { sent, deps } = recorder();

      await expect(reviveDeadTask(db, { ...read, deadAt: DEAD_AT }, deps)).resolves.toBeNull();

      expect(await task(id)).toMatchObject({ deadAt: null, orchestrationEpoch: 3 });
      expect(sent).toEqual([]);
    });
  });

  describe('a live task whose run list names a step this install does not register', () => {
    it('is marked dead at the epoch it was read, with its status and step kept', async () => {
      const id = await make({ runListSnapshot: [A, GONE, B] });
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 1, revived: 0 });

      const t = await task(id);
      expect(t).toMatchObject({ status: 'running', orchestrationEpoch: 3, currentStepId: A });
      expect(t.deadAt).toBeInstanceOf(Date);
      expect(t.deadReason).toContain(GONE);
      const [dead] = await events(id, 'task.dead');
      expect(dead?.payload).toMatchObject({ unresolved: [GONE], stepId: A, round: 0, epoch: 3 });
      expect(sent).toEqual([]);
    });

    it('is marked dead when its current step is not registered', async () => {
      const id = await make({ currentStepId: GONE, runListSnapshot: [A, B, GONE] });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect((await task(id)).deadAt).toBeInstanceOf(Date);
      const [dead] = await events(id, 'task.dead');
      expect((dead?.payload as { unresolved: string[] }).unresolved).toEqual([GONE]);
    });

    it('is marked dead, naming no unresolved id, when its current step is registered but unlisted', async () => {
      const id = await make({ runListSnapshot: [B], currentStepId: A });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      const t = await task(id);
      expect(t.deadAt).toBeInstanceOf(Date);
      expect(t.deadReason).toContain(A);
      const [dead] = await events(id, 'task.dead');
      expect(dead?.payload).toMatchObject({ unresolved: [], stepId: A });
    });

    it.each(['created', 'queued', 'waiting_user', 'waiting_pr', 'failed'] as const)(
      'is marked dead from %s',
      async (status) => {
        const id = await make({
          runListSnapshot: [A, GONE],
          status,
          currentStepId: status === 'created' || status === 'queued' ? null : A,
        });
        const { deps } = recorder();

        await reconcileDeadTasks(db, deps);

        expect(await task(id)).toMatchObject({ status, orchestrationEpoch: 3 });
        expect((await task(id)).deadAt).toBeInstanceOf(Date);
      },
    );

    it('ends every run it has open, started or not', async () => {
      const id = await make({ runListSnapshot: [A, GONE] });
      const step = await row(id, A, 'waiting_cli');
      const queued = await run(id, step.id);
      const started = await run(id, step.id, { mode: 'agent_mining', startedAt: DEAD_AT });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      for (const r of [queued, started]) {
        const after = await runOf(r.id);
        expect(after.exitCode).toBe(137);
        expect(after.endedAt).toBeInstanceOf(Date);
        expect(after.supersededAt).toBeInstanceOf(Date);
      }
    });

    it.each(['cancelled', 'completed'] as const)('leaves a %s task alone', async (status) => {
      const id = await make({ status, runListSnapshot: [A, GONE] });
      const before = await task(id);
      const { deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0 });

      expect(await task(id)).toEqual(before);
      expect(await events(id)).toHaveLength(0);
    });

    it('is marked once when two runs race for it', async () => {
      const id = await make({ runListSnapshot: [A, GONE] });
      const { deps } = recorder();

      await Promise.all([reconcileDeadTasks(db, deps), reconcileDeadTasks(db, deps)]);

      expect(await events(id, 'task.dead')).toHaveLength(1);
    });
  });

  describe('a live task that resolves, or that the pass cannot judge', () => {
    it('is untouched', async () => {
      const id = await make();
      await row(id, A, 'running');
      const before = await task(id);
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0, revived: 0 });

      expect(await task(id)).toEqual(before);
      expect(await events(id)).toHaveLength(0);
      expect(sent).toEqual([]);
    });

    it('is left alone without a run list snapshot', async () => {
      const id = await make({ runListSnapshot: null, currentStepId: GONE });
      const before = await task(id);
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await task(id)).toEqual(before);
    });

    it('is skipped, with the rest still judged, when its task type has no definition', async () => {
      const unjudged = await make({ type: 'j4a_no_such_type', runListSnapshot: [GONE] });
      const judged = await make({ runListSnapshot: [A, GONE] });
      const before = await task(unjudged);
      const { deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 1 });

      expect(await task(unjudged)).toEqual(before);
      expect((await task(judged)).deadAt).toBeInstanceOf(Date);
    });
  });

  describe('a dead task without a run list snapshot', () => {
    const makeDynamicDead = (over: Partial<typeof schema.tasks.$inferInsert> = {}) =>
      makeDead({ type: DYNAMIC, runListSnapshot: null, ...over });

    it.each([
      { status: 'queued', current: null, job: 'start' },
      { status: 'running', current: A, job: 'advance' },
    ] as const)(
      'is revived from $status once its current step resolves, and gets the $job job',
      async (c) => {
        const id = await makeDynamicDead({
          status: c.status,
          currentStepId: c.current,
          currentRound: 1,
        });
        const { sent, deps } = recorder();

        await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({
          marked: 0,
          revived: 1,
        });

        expect(await task(id)).toMatchObject({
          deadAt: null,
          deadReason: null,
          status: c.status,
          orchestrationEpoch: 4,
          currentStepId: c.current,
          currentRound: 1,
        });
        expect(sent).toEqual(
          c.job === 'start'
            ? [{ kind: 'start', taskId: id }]
            : [{ kind: 'advance', taskId: id, stepId: A, round: 1, epoch: 4 }],
        );
        const revived = await events(id, 'task.revived');
        expect(revived).toHaveLength(1);
        expect(revived[0]?.payload).toMatchObject({ epoch: 4, action: c.job });
      },
    );

    it('is revived the same way on a static type, for a task made before snapshots existed', async () => {
      const id = await makeDead({ runListSnapshot: null });
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ revived: 1 });

      expect(await task(id)).toMatchObject({ deadAt: null, orchestrationEpoch: 4 });
      expect(sent).toEqual([{ kind: 'advance', taskId: id, stepId: A, round: 0, epoch: 4 }]);
    });

    it('stays dead while a step its death named is missing, even with no current step', async () => {
      const id = await makeDynamicDead({ status: 'queued', currentStepId: null });
      await db.insert(schema.taskEvents).values({
        taskId: id,
        eventType: 'task.dead',
        payload: { reason: DEAD_REASON, unresolved: [GONE], epoch: 3 },
      });
      const before = await task(id);
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0, revived: 0 });
      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0, revived: 0 });

      expect(await task(id)).toEqual(before);
      expect(await events(id, 'task.revived')).toHaveLength(0);
      expect(sent).toEqual([]);
    });

    it('is revived once every step its death named is registered again', async () => {
      const id = await makeDynamicDead({ status: 'queued', currentStepId: null });
      await db.insert(schema.taskEvents).values({
        taskId: id,
        eventType: 'task.dead',
        payload: { reason: DEAD_REASON, unresolved: [B], epoch: 3 },
      });
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ revived: 1 });

      expect(await task(id)).toMatchObject({ deadAt: null, orchestrationEpoch: 4 });
      expect(sent).toEqual([{ kind: 'start', taskId: id }]);
    });

    it('is left alone while its current step is not registered', async () => {
      const id = await makeDynamicDead({ currentStepId: GONE });
      const before = await task(id);
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0, revived: 0 });

      expect(await task(id)).toEqual(before);
      expect(await events(id)).toHaveLength(0);
      expect(sent).toEqual([]);
    });

    it.each(['cancelled', 'completed'] as const)('is left alone once %s', async (status) => {
      const id = await makeDynamicDead({ status });
      const before = await task(id);
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0, revived: 0 });

      expect(await task(id)).toEqual(before);
      expect(sent).toEqual([]);
    });
  });

  describe('a live task without a run list snapshot', () => {
    it.each([A, GONE])('is not marked dead when its current step is %s', async (current) => {
      const id = await make({ type: DYNAMIC, runListSnapshot: null, currentStepId: current });
      const before = await task(id);
      const { sent, deps } = recorder();

      await expect(reconcileDeadTasks(db, deps)).resolves.toMatchObject({ marked: 0, revived: 0 });

      expect(await task(id)).toEqual(before);
      expect(await events(id)).toHaveLength(0);
      expect(sent).toEqual([]);
    });
  });

  describe('the runs a dead task has open at boot', () => {
    it('are ended when the task stays dead, started or not, whenever it was marked', async () => {
      const id = await makeDead({ runListSnapshot: [A, GONE] });
      const step = await row(id, A, 'waiting_cli');
      const queued = await run(id, step.id);
      const started = await run(id, null, { startedAt: DEAD_AT });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      for (const r of [queued, started]) {
        const after = await runOf(r.id);
        expect(after.endedAt).toBeInstanceOf(Date);
        expect(after.supersededAt).toBeInstanceOf(Date);
      }
      expect(await task(id)).toMatchObject({ deadAt: DEAD_AT, orchestrationEpoch: 3 });
    });

    it('are left to the reconcile when the task is revived', async () => {
      const id = await makeDead();
      const step = await row(id, A, 'waiting_cli');
      const orphan = await run(id, step.id, { startedAt: DEAD_AT });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await runOf(orphan.id)).toMatchObject({ endedAt: null, supersededAt: null });
    });

    it('are left alone on a task that is not dead', async () => {
      const id = await make();
      const step = await row(id, A, 'waiting_cli');
      const live = await run(id, step.id, { startedAt: DEAD_AT });
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await runOf(live.id)).toMatchObject({ endedAt: null, supersededAt: null });
    });

    it('are left alone on a task that was cancelled while dead', async () => {
      const id = await makeDead({ status: 'cancelled', runListSnapshot: [A, GONE] });
      const open = await run(id, null, { startedAt: DEAD_AT });
      const before = await runOf(open.id);
      const { deps } = recorder();

      await reconcileDeadTasks(db, deps);

      expect(await runOf(open.id)).toEqual(before);
    });
  });

  describe('markTaskDead', () => {
    it('supersedes the runs that have not started and leaves a started one alone', async () => {
      const id = await make();
      const step = await row(id, A, 'waiting_cli');
      const queued = await run(id, step.id);
      const recap = await run(id, null, { summaryForStepId: step.id });
      const started = await run(id, step.id, { mode: 'agent_mining', startedAt: DEAD_AT });
      const ended = await run(id, step.id, { startedAt: DEAD_AT, endedAt: DEAD_AT, exitCode: 0 });
      const superseded = await run(id, step.id, { supersededAt: DEAD_AT });
      const otherTask = await make();
      const elsewhere = await run(otherTask, null);
      const before = {
        started: await runOf(started.id),
        ended: await runOf(ended.id),
        superseded: await runOf(superseded.id),
        elsewhere: await runOf(elsewhere.id),
      };

      await expect(markTaskDead(db, id, 'gone', { epoch: 3, unresolved: [GONE] })).resolves.toBe(
        true,
      );

      for (const r of [queued, recap]) {
        const after = await runOf(r.id);
        expect(after.exitCode).toBe(137);
        expect(after.endedAt).toBeInstanceOf(Date);
        expect(after.supersededAt).toBeInstanceOf(Date);
        expect(after.startedAt).toBeNull();
      }
      expect(await runOf(started.id)).toEqual(before.started);
      expect(await runOf(ended.id)).toEqual(before.ended);
      expect(await runOf(superseded.id)).toEqual(before.superseded);
      expect(await runOf(elsewhere.id)).toEqual(before.elsewhere);
    });

    it.each([
      ['an epoch it was not at', { status: 'running', epoch: 2 }],
      ['a cancelled task', { status: 'cancelled', epoch: 3 }],
      ['a completed task', { status: 'completed', epoch: 3 }],
    ] as const)('supersedes nothing for %s', async (_name, c) => {
      const id = await make({ status: c.status });
      const queued = await run(id, null);
      const before = await runOf(queued.id);

      await expect(markTaskDead(db, id, 'gone', { epoch: c.epoch })).resolves.toBe(false);

      expect(await runOf(queued.id)).toEqual(before);
    });

    it('supersedes nothing a second time', async () => {
      const id = await make();
      await expect(markTaskDead(db, id, 'gone', { epoch: 3 })).resolves.toBe(true);
      const late = await run(id, null);
      const before = await runOf(late.id);

      await expect(markTaskDead(db, id, 'gone', { epoch: 3 })).resolves.toBe(false);

      expect(await runOf(late.id)).toEqual(before);
    });

    it('does not wait for a run another transaction holds', async () => {
      const id = await make();
      const held = await run(id, null);
      const free = await run(id, null);

      await db.transaction(async (tx) => {
        await tx
          .select({ id: schema.cliInvocations.id })
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.id, held.id))
          .for('update');
        await expect(markTaskDead(db, id, 'gone', { epoch: 3 })).resolves.toBe(true);
      });

      expect((await runOf(free.id)).supersededAt).toBeInstanceOf(Date);
      expect((await runOf(held.id)).supersededAt).toBeNull();
    });
  });

  describe.each([
    {
      event: 'step.done',
      source: A,
      snapshot: [A, B],
      next: { stepId: B, round: 0 },
      result: (finished: StepRow): AdvanceStepResult => ({
        status: 'done',
        row: finished,
        output: {},
      }),
    },
    {
      event: 'step.loop_back',
      source: REVIEW,
      snapshot: [FIX_LOOP_TARGET_STEP_ID, REVIEW],
      next: { stepId: FIX_LOOP_TARGET_STEP_ID, round: 1 },
      result: (finished: StepRow): AdvanceStepResult => ({
        status: 'loop_back',
        row: finished,
        diagnosis: 'the review found a defect',
        sourceStepId: REVIEW,
      }),
    },
    {
      event: 'step.revise',
      source: REVISER,
      snapshot: [FIX_LOOP_TARGET_STEP_ID, REVISER],
      next: { stepId: FIX_LOOP_TARGET_STEP_ID, round: 1 },
      result: (finished: StepRow): AdvanceStepResult => ({
        status: 'revise',
        row: finished,
        targetStepId: FIX_LOOP_TARGET_STEP_ID,
        sourceStepId: REVISER,
      }),
    },
  ])('a duplicate delivery of the advance of a finished step, $event', (kind) => {
    const deliver = (taskId: string, epoch = 3) =>
      processTaskJob(
        job(TASK_JOB_NAMES.ADVANCE_STEP, { taskId, userId, stepId: kind.source, round: 0, epoch }),
      );
    const finished = async () => {
      const id = await make({
        repositoryId,
        currentStepId: kind.source,
        runListSnapshot: kind.snapshot,
      });
      const done = await row(id, kind.source, 'done', {
        output: {},
        endedAt: DEAD_AT,
        updatedAt: DEAD_AT,
      });
      return { id, done };
    };
    const firstPass = (id: string, done: StepRow) =>
      handleResult(
        db,
        ctxFor(id, kind.snapshot, { currentStepId: kind.source }),
        kind.source,
        kind.result(done),
      );
    const loseHandOff = async (id: string) => {
      await db
        .update(schema.tasks)
        .set({ currentStepId: kind.source, currentRound: 0 })
        .where(eq(schema.tasks.id, id));
      h.adds.length = 0;
    };
    const recorded = async (id: string, done: StepRow) =>
      (await events(id, kind.event)).filter((e) => e.taskStepId === done.id);
    const expectHandedOn = async (id: string, epoch = 3) => {
      expect((await task(id)).currentStepId).toBe(kind.next.stepId);
      expect(h.adds).toEqual([
        {
          name: TASK_JOB_NAMES.ADVANCE_STEP,
          data: { taskId: id, userId, stepId: kind.next.stepId, round: kind.next.round, epoch },
        },
      ]);
    };

    it('records no second event when the first pass recorded one, and still hands the task on', async () => {
      const { id, done } = await finished();
      await firstPass(id, done);
      await loseHandOff(id);

      await deliver(id);

      expect(await recorded(id, done)).toHaveLength(1);
      await expectHandedOn(id);
    });

    it('stamps the event with the ended_at of the row it ends', async () => {
      const { id, done } = await finished();

      await firstPass(id, done);

      expect((await recorded(id, done)).map((e) => e.payload)).toMatchObject([
        { endedAt: DEAD_AT.toISOString() },
      ]);
    });

    it('appends the event of a first pass whatever is recorded', async () => {
      const { id, done } = await finished();
      await firstPass(id, done);
      await loseHandOff(id);

      await firstPass(id, done);

      expect(await recorded(id, done)).toHaveLength(2);
    });

    it('records the event a first pass died before recording, once however often it is re-driven', async () => {
      const { id, done } = await finished();
      const earlier = await row(id, 'j4a-earlier', 'done');
      const otherRound = await row(id, kind.source, 'done', { round: 1 });
      const stamped = { stepId: kind.source, endedAt: DEAD_AT.toISOString() };
      await db.insert(schema.taskEvents).values([
        { taskId: id, taskStepId: earlier.id, eventType: kind.event, payload: stamped },
        { taskId: id, taskStepId: otherRound.id, eventType: kind.event, payload: stamped },
        { taskId: id, taskStepId: done.id, eventType: 'step.waiting_cli', payload: stamped },
      ]);

      await deliver(id);
      await loseHandOff(id);
      await deliver(id);

      expect(await recorded(id, done)).toHaveLength(1);
      expect(await events(id, kind.event)).toHaveLength(3);
      await expectHandedOn(id);
    });

    it('records the event of a rerun after a Retry whose pass died before recording', async () => {
      const { id, done } = await finished();
      await firstPass(id, done);
      const rerunEndedAt = new Date(DEAD_AT.getTime() + 3_600_000);
      await resetStepAndDownstream(db, id, kind.source, 0);
      await db
        .update(schema.taskSteps)
        .set({ status: 'done', output: {}, endedAt: rerunEndedAt, updatedAt: rerunEndedAt })
        .where(eq(schema.taskSteps.id, done.id));
      await loseHandOff(id);

      await deliver(id, 4);

      const both = await recorded(id, done);
      expect(both).toHaveLength(2);
      expect(both.map((e) => e.payload)).toMatchObject([
        { endedAt: DEAD_AT.toISOString() },
        { endedAt: rerunEndedAt.toISOString() },
      ]);
      await expectHandedOn(id, 4);
    });

    it('records no second event when the epoch moved on after the first pass, as a revive or a stalled re-drive moves it', async () => {
      const { id, done } = await finished();
      await firstPass(id, done);
      await loseHandOff(id);
      await db.update(schema.tasks).set({ orchestrationEpoch: 4 }).where(eq(schema.tasks.id, id));

      await deliver(id, 4);

      expect(await recorded(id, done)).toHaveLength(1);
      await expectHandedOn(id, 4);
    });

    it('records the event again when the earlier one carries no stamp', async () => {
      const { id, done } = await finished();
      await db.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: done.id,
        eventType: kind.event,
        payload: { stepId: kind.source },
      });

      await deliver(id);

      expect(await recorded(id, done)).toHaveLength(2);
      await expectHandedOn(id);
    });

    it('records the event again when the row carries no ended_at', async () => {
      const { id, done } = await finished();
      await db
        .update(schema.taskSteps)
        .set({ endedAt: null })
        .where(eq(schema.taskSteps.id, done.id));
      await db.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: done.id,
        eventType: kind.event,
        payload: { stepId: kind.source, endedAt: null },
      });

      await deliver(id);

      expect(await recorded(id, done)).toHaveLength(2);
      await expectHandedOn(id);
    });
  });

  describe('a walk that finds the task on a step outside its run list', () => {
    it('names no unresolved id when the finished step is registered', async () => {
      const id = await make({ runListSnapshot: [B], currentStepId: A });
      const finished = await row(id, A, 'done');

      await handleResult(db, ctxFor(id, [B]), A, { status: 'done', row: finished, output: {} });

      expect((await task(id)).deadAt).toBeInstanceOf(Date);
      const [dead] = await events(id, 'task.dead');
      expect(dead?.payload).toMatchObject({ unresolved: [], stepId: A, round: 0 });
      expect((await task(id)).deadReason).toContain(A);
    });

    it('names no unresolved id when a fix-loop gate is accepted on a registered step', async () => {
      const id = await make({ runListSnapshot: [B], currentStepId: A });
      const gate = await row(id, A, 'waiting_form');

      await resolveFixLoopGate(db, ctxFor(id, [B]), gate, 'accept', 0, '');

      expect((await task(id)).deadAt).toBeInstanceOf(Date);
      const [dead] = await events(id, 'task.dead');
      expect(dead?.payload).toMatchObject({ unresolved: [], stepId: A });
    });

    it('still names the target of a revise that does not resolve', async () => {
      const id = await make({ runListSnapshot: [A, B], currentStepId: A });
      const finished = await row(id, A, 'done');

      await handleResult(db, ctxFor(id, [A, B]), A, {
        status: 'revise',
        row: finished,
        targetStepId: GONE,
        sourceStepId: A,
      });

      const [dead] = await events(id, 'task.dead');
      expect(dead?.payload).toMatchObject({ unresolved: [GONE], stepId: A });
    });
  });

  describe('boot order', () => {
    const orphanedRun = async (taskId: string) => {
      const step = await row(taskId, A, 'waiting_cli');
      return run(taskId, step.id, { startedAt: DEAD_AT });
    };
    const reconcile = () => {
      const advances: Sent[] = [];
      return {
        advances,
        deps: {
          enqueueAdvance: async (
            taskId: string,
            _userId: string,
            stepId: string,
            round: number,
            epoch: number,
          ) => {
            advances.push({ kind: 'advance', taskId, stepId, round, epoch });
          },
          queuedInvocationIds: async () => new Set<string>(),
        },
      };
    };

    it('ends the orphaned run of a revived task when the revive comes first', async () => {
      const id = await makeDead();
      const orphan = await orphanedRun(id);
      const revive = recorder();
      const after = reconcile();

      await reconcileDeadTasks(db, revive.deps);
      expect((await runOf(orphan.id)).endedAt).toBeNull();
      await reconcileOrphanedSteps(db, after.deps);

      expect((await runOf(orphan.id)).endedAt).toBeInstanceOf(Date);
      expect(after.advances).toEqual([
        { kind: 'advance', taskId: id, stepId: A, round: 0, epoch: 5 },
      ]);
      expect((await task(id)).orchestrationEpoch).toBe(5);
    });

    it('leaves the run open when the reconcile comes first', async () => {
      const id = await makeDead();
      const orphan = await orphanedRun(id);
      const revive = recorder();
      const before = reconcile();

      await reconcileOrphanedSteps(db, before.deps);
      await reconcileDeadTasks(db, revive.deps);

      expect((await runOf(orphan.id)).endedAt).toBeNull();
      expect(before.advances).toEqual([]);
    });
  });
});
