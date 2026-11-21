import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { DelayedError } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import {
  enqueueRedrive,
  handleResult,
  processTaskJob,
  reconcileOrphanedSteps,
  resolveFixLoopGate,
} from '../src/queues/task-queue.js';
import {
  reconcileDeadTasks,
  retryHeldRevivals,
  reviveDeadTask,
  type DeadTaskBootDeps,
  type DeadTaskView,
} from '../src/queues/dead-task-boot.js';
import { redriveStalledTasks, type StalledRedriveDeps } from '../src/queues/stalled-redrive.js';
import { autoResumeFailedStep, resetStepAndDownstream } from '../src/queues/_step-reset.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  StepSupersededError,
  lockOwnedStep,
  updateOwnedStep,
} from '../src/step-engine/step-ownership.js';
import { recordFixLoopRequest } from '../src/step-engine/steps/workflow/_fix-loop.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  adds: [] as { name: string; data: Record<string, unknown> }[],
  fence: vi.fn(),
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
    async add(name: string, data: Record<string, unknown>) {
      h.adds.push({ name, data });
    }
  },
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-kill.js')>()),
  killCliSandboxesForTask: async () => 0,
}));
vi.mock('../src/step-engine/execution-contract-support.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/execution-contract-support.js')>()),
  assertWorkerExecutionContractSupported: h.fence,
}));

const url = process.env.CUSTOM_FIX_RECOVERY_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/custom_fix_recovery_test'))
  throw new Error('Use a dedicated custom_fix_recovery_test database');

const BASE_EPOCH = 3;
const ROLES = ['TARGET', 'REVIEW', 'AFTER'] as const;
type Role = (typeof ROLES)[number];
type StepRow = typeof schema.taskSteps.$inferSelect;

interface Leg {
  name: string;
  type: string;
  ids: Record<Role, string>;
  pin: object | null;
}

const customTarget = 'module.cfr-fix.target';
const LEGS: Leg[] = [
  {
    name: 'ordinary',
    type: 'cfr_ordinary_type',
    ids: { TARGET: '07-phase-2-implement', REVIEW: 'cfr-o-review', AFTER: 'cfr-o-after' },
    pin: null,
  },
  {
    name: 'custom',
    type: 'cfr_custom_type',
    ids: { TARGET: customTarget, REVIEW: 'cfr-c-review', AFTER: 'cfr-c-after' },
    pin: {
      version: 1,
      guardedSpans: [],
      fixTarget: { stepId: customTarget, capabilityVersion: 1 },
    },
  },
];

const applied: Record<string, number> = {};
const gate = { held: undefined as Promise<void> | undefined, stepId: '' };

function stub(id: string, index: number, type: string, over: object = {}): void {
  stepRegistry.register({
    metadata: {
      id,
      workflowType: type as WorkflowType,
      index,
      title: id,
      description: id,
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    form() {
      return null;
    },
    async apply() {
      applied[id] = (applied[id] ?? 0) + 1;
      if (gate.held && id === gate.stepId) await gate.held;
      return {};
    },
    ...over,
  } as unknown as StepDefinition);
}

const ordinaryTraces = new Map<string, unknown>();

describe.skipIf(!url)('recovery of a fix round on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;
  const email = randomBytes(8).toString('hex');

  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: `${email}@test.local`,
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: randomBytes(32).toString('hex'),
        status: 'active',
        role: 'user',
      })
      .returning();
    userId = user!.id;
    const [repository] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: `cfr-${randomUUID()}`,
        source: 'local_path',
        localPath: '/tmp',
        storagePath: '/tmp',
        status: 'ready',
      })
      .returning();
    repositoryId = repository!.id;
    for (const leg of LEGS) {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: leg.type,
        displayName: leg.type,
        source: 'test',
        runListStrategy: 'static',
      });
      stub(
        leg.ids.TARGET,
        0,
        leg.type,
        leg.pin ? { fixConsumer: { version: 1 }, editsCodeOrTests: true } : {},
      );
      stub(leg.ids.REVIEW, 1, leg.type, {
        fixLoop: { evaluate: () => ({ blocking: true, diagnosis: 'the review found a defect' }) },
      });
      stub(leg.ids.AFTER, 2, leg.type);
    }
  });
  beforeEach(async () => {
    h.adds.length = 0;
    h.fence.mockReset();
    for (const key of Object.keys(applied)) delete applied[key];
    gate.held = undefined;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    for (const leg of LEGS)
      await db
        .delete(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.slug, leg.type));
    await db.$client.end({ timeout: 5 });
  });

  const seedTask = async (leg: Leg, over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: leg.type,
        title: 'custom fix recovery',
        metadata: { anchorRepositoryId: null },
        status: 'running',
        orchestrationEpoch: BASE_EPOCH,
        currentStepId: leg.ids.REVIEW,
        currentRound: 0,
        runListSnapshot: [leg.ids.TARGET, leg.ids.REVIEW, leg.ids.AFTER],
        executionContract: leg.pin,
        updatedAt: new Date(Date.now() - 60_000),
        ...over,
      })
      .returning();
    return made!.id;
  };
  const seedRow = async (
    leg: Leg,
    taskId: string,
    role: Role,
    round: number,
    status: StepRow['status'],
    over: Partial<typeof schema.taskSteps.$inferInsert> = {},
  ) => {
    const index = ROLES.indexOf(role);
    const [made] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: leg.ids[role],
        stepIndex: index,
        runSeq: index,
        round,
        title: leg.ids[role],
        status,
        updatedAt: new Date(Date.now() - 60_000),
        ...over,
      })
      .returning();
    return made!;
  };
  const seedEvent = (taskId: string, eventType: string, payload: Record<string, unknown> = {}) =>
    db.insert(schema.taskEvents).values({ taskId, eventType, payload });
  const taskOf = async (id: string) =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;
  const rowOf = async (id: string) =>
    (await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, id)))[0]!;
  const eventsOf = async (id: string, type?: string) =>
    (
      await db
        .select()
        .from(schema.taskEvents)
        .where(
          type
            ? and(eq(schema.taskEvents.taskId, id), eq(schema.taskEvents.eventType, type))
            : eq(schema.taskEvents.taskId, id),
        )
        .orderBy(asc(schema.taskEvents.createdAt), asc(schema.taskEvents.eventType))
    ).map((e) => e);
  const ctxFor = async (leg: Leg, taskId: string): Promise<ResolvedTaskContext> => {
    const t = await taskOf(taskId);
    return {
      taskId,
      userId,
      workflowType: leg.type as WorkflowType,
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: null,
      ignoreSavedStepClis: false,
      executionPath: null,
      metadata: null,
      orchestrationEpoch: t.orchestrationEpoch,
      currentStepId: t.currentStepId,
      currentRound: t.currentRound,
      status: t.status,
      completedAt: t.completedAt,
      runListStrategy: 'static',
      runListSnapshot: t.runListSnapshot,
      executionContract: t.executionContract,
      fixLoop: null,
    };
  };
  const job = (name: string, data: object) =>
    ({
      id: randomUUID(),
      name,
      data,
      timestamp: Date.now(),
      moveToDelayed: async () => undefined,
    }) as unknown as Parameters<typeof processTaskJob>[0];
  const advance = (
    leg: Leg,
    taskId: string,
    role: Role,
    round: number,
    epoch?: number,
    extra = {},
  ) =>
    job(TASK_JOB_NAMES.ADVANCE_STEP, {
      taskId,
      userId,
      stepId: leg.ids[role],
      round,
      ...(epoch === undefined ? {} : { epoch }),
      ...extra,
    });

  const roleOf = (leg: Leg, id: string | null | undefined): string | null | undefined => {
    if (id === null || id === undefined) return id;
    return ROLES.find((r) => leg.ids[r] === id) ?? id;
  };
  const trace = async (leg: Leg, taskId: string) => {
    const t = await taskOf(taskId);
    const rows = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId));
    const order = (r: StepRow) => (ROLES as readonly string[]).indexOf(roleOf(leg, r.stepId)!);
    return {
      task: {
        step: roleOf(leg, t.currentStepId),
        round: t.currentRound,
        status: t.status,
        epoch: t.orchestrationEpoch - BASE_EPOCH,
        dead: t.deadAt !== null,
      },
      rows: rows
        .sort((a, b) => a.round - b.round || order(a) - order(b))
        .map((r) => `${roleOf(leg, r.stepId)}@${r.round}:${r.status}`),
      events: (await eventsOf(taskId)).map((e) => e.eventType),
      jobs: h.adds.map((a) => {
        const d = a.data as { stepId?: string; round?: number; epoch?: number };
        return `${a.name}:${roleOf(leg, d.stepId)}@${d.round}+${(d.epoch ?? BASE_EPOCH) - BASE_EPOCH}`;
      }),
      applies: Object.fromEntries(
        ROLES.map((r) => [r, applied[leg.ids[r]] ?? 0]).filter(([, n]) => n !== 0),
      ),
    };
  };
  const verdict = (key: string, leg: Leg, actual: unknown, golden: unknown) => {
    if (leg.name === 'custom') expect(actual).toEqual(ordinaryTraces.get(key));
    else ordinaryTraces.set(key, actual);
    expect(actual).toEqual(golden);
  };

  describe.each(LEGS)('$name leg', (leg) => {
    const loopBack = async (taskId: string, row: StepRow, diagnosis: string) =>
      handleResult(db, await ctxFor(leg, taskId), row.stepId, {
        status: 'loop_back',
        row,
        diagnosis,
        sourceStepId: row.stepId,
      });

    it('loop_back from the review enters the target once, and a redelivered advance adds nothing', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      await loopBack(id, source, 'defect');
      await processTaskJob(advance(leg, id, 'REVIEW', 0, BASE_EPOCH));
      verdict('S1', leg, await trace(leg, id), {
        task: { step: 'TARGET', round: 1, status: 'running', epoch: 0, dead: false },
        rows: ['REVIEW@0:done'],
        events: ['step.loop_back', 'fix_loop.requested', 'fix_loop.started'],
        jobs: ['advance-step:TARGET@1+0'],
        applies: {},
      });
    });

    it('the cap parks the source gate with an escalation and starts no further round', async () => {
      const id = await seedTask(leg, { maxFixRounds: 2 });
      for (const round of [0, 1, 2]) {
        const source = await seedRow(leg, id, 'REVIEW', round, 'done');
        await db
          .update(schema.tasks)
          .set({ currentStepId: leg.ids.REVIEW, currentRound: round, status: 'running' })
          .where(eq(schema.tasks.id, id));
        await loopBack(id, source, `defect ${round}`);
      }
      verdict('S2', leg, await trace(leg, id), {
        task: { step: 'REVIEW', round: 2, status: 'waiting_user', epoch: 0, dead: false },
        rows: ['REVIEW@0:done', 'REVIEW@1:done', 'REVIEW@2:waiting_form'],
        events: [
          'step.loop_back',
          'fix_loop.requested',
          'fix_loop.started',
          'step.loop_back',
          'fix_loop.requested',
          'fix_loop.started',
          'step.loop_back',
          'fix_loop.requested',
          'fix_loop.escalated',
        ],
        jobs: ['advance-step:TARGET@1+0', 'advance-step:TARGET@2+0'],
        applies: {},
      });
      expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(2);
    });

    it('the oscillation gate parks the source, records the next request and starts nothing', async () => {
      const id = await seedTask(leg, { currentRound: 2 });
      const first = await seedRow(leg, id, 'REVIEW', 0, 'done');
      const gateRow = await seedRow(leg, id, 'REVIEW', 2, 'done');
      await recordFixLoopRequest(db, id, first.id, {
        round: 1,
        sourceStepId: leg.ids.REVIEW,
        diagnosis: 'same defect',
      });
      await recordFixLoopRequest(db, id, first.id, {
        round: 2,
        sourceStepId: leg.ids.AFTER,
        diagnosis: 'other defect',
      });
      await loopBack(id, gateRow, 'same defect');
      verdict('S3', leg, await trace(leg, id), {
        task: { step: 'REVIEW', round: 2, status: 'waiting_user', epoch: 0, dead: false },
        rows: ['REVIEW@0:done', 'REVIEW@2:waiting_form'],
        events: [
          'fix_loop.requested',
          'fix_loop.requested',
          'step.loop_back',
          'fix_loop.requested',
          'fix_loop.oscillation_detected',
        ],
        jobs: [],
        applies: {},
      });
    });

    describe('gate answers', () => {
      const parkedGate = async () => {
        const id = await seedTask(leg, { status: 'waiting_user', currentRound: 1 });
        const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
        const gateRow = await seedRow(leg, id, 'REVIEW', 1, 'waiting_form', {
          waitingStartedAt: new Date(),
        });
        await recordFixLoopRequest(db, id, source.id, {
          round: 2,
          sourceStepId: leg.ids.REVIEW,
          diagnosis: 'defect',
        });
        return { id, gateRow };
      };
      const answer = async (id: string, gateRow: StepRow, action: string) =>
        resolveFixLoopGate(db, await ctxFor(leg, id), gateRow, action, 1, '');

      it('continue re-enters the target at the next round', async () => {
        const { id, gateRow } = await parkedGate();
        await answer(id, gateRow, 'continue');
        verdict('S4-continue', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 2, status: 'running', epoch: 0, dead: false },
          rows: ['REVIEW@0:done', 'REVIEW@1:done'],
          events: ['fix_loop.requested', 'fix_loop.continued'],
          jobs: ['advance-step:TARGET@2+0'],
          applies: {},
        });
      });

      it('accept hands the task to the step after the source', async () => {
        const { id, gateRow } = await parkedGate();
        await answer(id, gateRow, 'accept');
        verdict('S4-accept', leg, await trace(leg, id), {
          task: { step: 'AFTER', round: 1, status: 'running', epoch: 0, dead: false },
          rows: ['REVIEW@0:done', 'REVIEW@1:done'],
          events: ['fix_loop.requested', 'fix_loop.accepted', 'fix_loop.accepted'],
          jobs: ['advance-step:AFTER@1+0'],
          applies: {},
        });
      });

      it('abort fails the task and queues nothing', async () => {
        const { id, gateRow } = await parkedGate();
        await answer(id, gateRow, 'abort');
        verdict('S4-abort', leg, await trace(leg, id), {
          task: { step: 'REVIEW', round: 1, status: 'failed', epoch: 0, dead: false },
          rows: ['REVIEW@0:done', 'REVIEW@1:done'],
          events: ['fix_loop.requested', 'fix_loop.aborted'],
          jobs: [],
          applies: {},
        });
      });

      it('a redelivered answer after the pointer moved queues no second job', async () => {
        const { id, gateRow } = await parkedGate();
        await answer(id, gateRow, 'continue');
        await processTaskJob(
          advance(leg, id, 'REVIEW', 1, BASE_EPOCH, { formValues: { fixLoopAction: 'continue' } }),
        );
        verdict('S4-redelivered', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 2, status: 'running', epoch: 0, dead: false },
          rows: ['REVIEW@0:done', 'REVIEW@1:done'],
          events: ['fix_loop.requested', 'fix_loop.continued'],
          jobs: ['advance-step:TARGET@2+0'],
          applies: {},
        });
      });
    });

    describe('duplicate advance', () => {
      it('two concurrent identical advances run apply once', async () => {
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        await seedRow(leg, id, 'REVIEW', 0, 'done');
        let release!: () => void;
        gate.stepId = leg.ids.TARGET;
        gate.held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const deferred = vi.fn(async () => undefined);
        const first = processTaskJob(advance(leg, id, 'TARGET', 1, BASE_EPOCH), 'token-1');
        await vi.waitFor(() => expect(applied[leg.ids.TARGET]).toBe(1));
        const second = job(TASK_JOB_NAMES.ADVANCE_STEP, {
          taskId: id,
          userId,
          stepId: leg.ids.TARGET,
          round: 1,
          epoch: BASE_EPOCH,
        });
        (second as unknown as { moveToDelayed: unknown }).moveToDelayed = deferred;
        const outcome = processTaskJob(second, 'token-2').then(
          () => null,
          (err: unknown) => err,
        );
        await vi.waitFor(() => expect(deferred).toHaveBeenCalledTimes(1));
        release();
        expect(await outcome).toBeInstanceOf(DelayedError);
        await first;
        await processTaskJob(advance(leg, id, 'TARGET', 1, BASE_EPOCH));
        verdict('S5-concurrent', leg, await trace(leg, id), {
          task: { step: 'REVIEW', round: 1, status: 'running', epoch: 0, dead: false },
          rows: ['REVIEW@0:done', 'TARGET@1:done'],
          events: ['step.done'],
          jobs: ['advance-step:REVIEW@1+0'],
          applies: { TARGET: 1 },
        });
      });

      it('an advance with an older epoch is dropped', async () => {
        const id = await seedTask(leg, {
          currentStepId: leg.ids.TARGET,
          currentRound: 1,
          orchestrationEpoch: BASE_EPOCH + 2,
        });
        await processTaskJob(advance(leg, id, 'TARGET', 1, BASE_EPOCH + 1));
        const traced = await trace(leg, id);
        verdict('S5-stale', leg, traced, {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 2, dead: false },
          rows: [],
          events: [],
          jobs: [],
          applies: {},
        });
      });
    });

    describe('crash windows', () => {
      const none = async () => new Set<string>();
      const owed = async () => ({
        steps: new Set(h.adds.map((a) => a.data.taskId as string)),
        starts: new Set<string>(),
      });
      const sweepDeps: StalledRedriveDeps = {
        enqueueAdvance: enqueueRedrive,
        failTask: async () => false,
        enqueueStart: async () => undefined,
        queuedTaskJobs: owed,
        queuedInvocationIds: none,
        stepHeld: () => false,
        redriveRetryDelaysMs: [],
      };
      const boot = async () => {
        await reconcileOrphanedSteps(db, {
          enqueueAdvance: enqueueRedrive,
          queuedInvocationIds: none,
        });
        await redriveStalledTasks(db, sweepDeps, { staleMs: 0 });
      };
      const twice = async () => {
        await boot();
        const afterFirst = h.adds.length;
        await boot();
        expect(h.adds).toHaveLength(afterFirst);
      };
      const entered = async (taskId: string, sourceRowId: string) => {
        await recordFixLoopRequest(db, taskId, sourceRowId, {
          round: 1,
          sourceStepId: leg.ids.REVIEW,
          diagnosis: 'defect',
        });
        await seedEvent(taskId, 'fix_loop.started', { sourceStepId: leg.ids.REVIEW, round: 1 });
      };

      it('pointer at the target with a started round and no row', async () => {
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        await entered(id, (await seedRow(leg, id, 'REVIEW', 0, 'done')).id);
        await twice();
        verdict('S6-no-row', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 1, dead: false },
          rows: ['REVIEW@0:done'],
          events: ['fix_loop.requested', 'fix_loop.started'],
          jobs: ['advance-step:TARGET@1+1'],
          applies: {},
        });
        expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
      });

      it('a running target row with no CLI work behind it', async () => {
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        await entered(id, (await seedRow(leg, id, 'REVIEW', 0, 'done')).id);
        await seedRow(leg, id, 'TARGET', 1, 'running', { startedAt: new Date() });
        await twice();
        verdict('S6-running', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 1, dead: false },
          rows: ['REVIEW@0:done', 'TARGET@1:pending'],
          events: ['fix_loop.requested', 'fix_loop.started'],
          jobs: ['advance-step:TARGET@1+1'],
          applies: {},
        });
        expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
      });

      it('a finished source whose hand-off was lost is handed on once', async () => {
        const id = await seedTask(leg);
        await seedRow(leg, id, 'REVIEW', 0, 'done', { output: {}, endedAt: new Date() });
        await twice();
        expect(h.adds).toHaveLength(1);
        await processTaskJob(job(h.adds[0]!.name, h.adds[0]!.data));
        await twice();
        verdict('S6-source-done', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 1, dead: false },
          rows: ['REVIEW@0:done'],
          events: ['step.loop_back', 'fix_loop.requested', 'fix_loop.started'],
          jobs: ['advance-step:REVIEW@0+1', 'advance-step:TARGET@1+1'],
          applies: {},
        });
        expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
      });
    });

    describe('resets', () => {
      it('resets the target round and its downstream only, with one epoch bump', async () => {
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        for (const round of [0, 1])
          for (const role of ROLES) await seedRow(leg, id, role, round, 'done');
        const reset = await resetStepAndDownstream(
          db,
          id,
          leg.ids.TARGET,
          1,
          BASE_EPOCH,
          false,
          [],
          (await taskOf(id)).executionContract,
        );
        expect(reset).toEqual({ downstreamReset: 2, newEpoch: BASE_EPOCH + 1 });
        verdict('S7-reset', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 1, dead: false },
          rows: [
            'TARGET@0:done',
            'REVIEW@0:done',
            'AFTER@0:done',
            'TARGET@1:pending',
            'REVIEW@1:pending',
            'AFTER@1:pending',
          ],
          events: [],
          jobs: [],
          applies: {},
        });
      });

      it('a reset at an epoch the task left changes nothing', async () => {
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        await seedRow(leg, id, 'TARGET', 1, 'done');
        const reset = await resetStepAndDownstream(db, id, leg.ids.TARGET, 1, BASE_EPOCH - 1);
        expect(reset).toBe('superseded');
        verdict('S7-superseded', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 0, dead: false },
          rows: ['TARGET@1:done'],
          events: [],
          jobs: [],
          applies: {},
        });
      });

      it('an auto-resume reopens the failed target row of its round only', async () => {
        const id = await seedTask(leg, {
          currentStepId: leg.ids.TARGET,
          currentRound: 1,
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'provider outage',
        });
        await seedRow(leg, id, 'TARGET', 0, 'done');
        await seedRow(leg, id, 'TARGET', 1, 'failed', { errorMessage: 'provider outage' });
        const resumed = await autoResumeFailedStep(db, {
          taskId: id,
          stepId: leg.ids.TARGET,
          round: 1,
          providerId: null,
          via: 'test',
          watchSince: null,
        });
        expect(resumed).toBe(true);
        verdict('S7-auto-resume', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 0, dead: false },
          rows: ['TARGET@0:done', 'TARGET@1:running'],
          events: ['task.auto_resumed'],
          jobs: [],
          applies: {},
        });
      });
    });

    describe('ownership', () => {
      it('refuses a write from an older generation and a lock on a superseded row', async () => {
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        const row = await seedRow(leg, id, 'TARGET', 1, 'running', { rerunGeneration: 2 });
        await expect(
          updateOwnedStep(db, row.id, { statusMessage: 'late' }, 1),
        ).rejects.toBeInstanceOf(StepSupersededError);
        expect((await rowOf(row.id)).statusMessage).toBeNull();
        await updateOwnedStep(db, row.id, { statusMessage: 'current' }, 2);
        expect(await lockOwnedStep(db, row.id)).toBe(true);
        for (const status of ['pending', 'skipped', 'failed'] as const) {
          await db.update(schema.taskSteps).set({ status }).where(eq(schema.taskSteps.id, row.id));
          expect(await lockOwnedStep(db, row.id)).toBe(false);
          await expect(updateOwnedStep(db, row.id, { statusMessage: 'x' })).rejects.toBeInstanceOf(
            StepSupersededError,
          );
        }
        expect((await rowOf(row.id)).statusMessage).toBe('current');
        verdict('S8', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 0, dead: false },
          rows: ['TARGET@1:failed'],
          events: [],
          jobs: [],
          applies: {},
        });
      });
    });

    describe('dead-task revival', () => {
      const deps: DeadTaskBootDeps = {
        enqueueStart: async () => undefined,
        enqueueAdvance: enqueueRedrive,
        redriveRetryDelaysMs: [],
      };
      const deadAt = new Date('2026-10-14T08:00:00.000Z');
      const view = async (id: string): Promise<DeadTaskView> => {
        const t = await taskOf(id);
        return {
          id,
          userId,
          epoch: t.orchestrationEpoch,
          currentStepId: t.currentStepId,
          currentRound: t.currentRound,
          deadAt: t.deadAt,
          deadReason: t.deadReason,
        };
      };
      const deadAtTarget = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
        const id = await seedTask(leg, {
          currentStepId: leg.ids.TARGET,
          currentRound: 1,
          deadAt,
          deadReason: 'a step this install does not register',
          ...over,
        });
        await seedRow(leg, id, 'REVIEW', 0, 'done');
        await seedRow(leg, id, 'TARGET', 1, 'pending');
        return id;
      };
      const withoutCapability = async (body: () => Promise<void>) => {
        const original = stepRegistry.require(leg.ids.TARGET);
        stepRegistry.override({
          ...original,
          fixConsumer: undefined,
          editsCodeOrTests: undefined,
        } as unknown as StepDefinition);
        try {
          await body();
        } finally {
          stepRegistry.override(original);
        }
      };
      const snapshotOf = async (id: string) => ({
        task: await taskOf(id),
        rows: await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, id)),
        events: await eventsOf(id),
      });

      it('a capable target is revived once, one advance at the round it died on', async () => {
        const id = await deadAtTarget();
        expect(await reviveDeadTask(db, await view(id), deps)).toBe('advance');
        expect(await reviveDeadTask(db, await view(id), deps)).toBeNull();
        verdict('S9-capable', leg, await trace(leg, id), {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 1, dead: false },
          rows: ['REVIEW@0:done', 'TARGET@1:pending'],
          events: ['task.revived'],
          jobs: ['advance-step:TARGET@1+1'],
          applies: {},
        });
      });

      const needsCapability = leg.pin !== null;

      it('a target that lost its capability stays dead and changes nothing; restored, it is revived once', async () => {
        const id = await deadAtTarget();
        const before = await snapshotOf(id);
        await withoutCapability(async () => {
          const outcome = await reviveDeadTask(db, await view(id), deps);
          if (needsCapability) {
            expect(outcome).toBeNull();
            expect(await snapshotOf(id)).toEqual(before);
            expect(h.adds).toEqual([]);
          } else {
            expect(outcome).toBe('advance');
          }
        });
        if (needsCapability) {
          expect(await reviveDeadTask(db, await view(id), deps)).toBe('advance');
        }
        expect(h.adds).toHaveLength(1);
        expect(h.adds[0]!.data).toMatchObject({
          stepId: leg.ids.TARGET,
          round: 1,
          epoch: BASE_EPOCH + 1,
        });
        expect((await taskOf(id)).deadAt).toBeNull();
      });

      it('a live task on a target without the capability is marked dead, rows untouched; restored, it is revived once', async () => {
        const id = await deadAtTarget({ deadAt: null, deadReason: null });
        const before = (await snapshotOf(id)).rows;
        await withoutCapability(async () => {
          expect(await reconcileDeadTasks(db, deps)).toMatchObject({
            marked: needsCapability ? 1 : 0,
            revived: 0,
            failed: 0,
          });
          expect((await taskOf(id)).deadAt !== null).toBe(needsCapability);
          expect((await snapshotOf(id)).rows).toEqual(before);
          expect(h.adds).toEqual([]);
        });
        expect(await reconcileDeadTasks(db, deps)).toMatchObject({
          marked: 0,
          revived: needsCapability ? 1 : 0,
          failed: 0,
        });
        expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 0, revived: 0 });
        expect((await snapshotOf(id)).rows).toEqual(before);
        expect(h.adds).toHaveLength(needsCapability ? 1 : 0);
        expect((await taskOf(id)).deadAt).toBeNull();
      });

      it('retryHeldRevivals revives a restored target once and stops', async () => {
        const id = await deadAtTarget();
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
          const stop = retryHeldRevivals(db, deps, 10);
          await vi.advanceTimersByTimeAsync(10);
          await vi.waitFor(async () => expect((await taskOf(id)).deadAt).toBeNull());
          await vi.advanceTimersByTimeAsync(100);
          stop();
        } finally {
          vi.useRealTimers();
        }
        expect(h.adds).toHaveLength(1);
        expect(h.adds[0]!.data).toMatchObject({
          stepId: leg.ids.TARGET,
          round: 1,
          epoch: BASE_EPOCH + 1,
        });
      });
    });

    describe('the closed fence', () => {
      it('the real fence refuses the custom task in the judge and leaves the ordinary one alone', async () => {
        const actual = await vi.importActual<
          typeof import('../src/step-engine/execution-contract-support.js')
        >('../src/step-engine/execution-contract-support.js');
        h.fence.mockImplementation(actual.assertWorkerExecutionContractSupported);
        const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
        await seedRow(leg, id, 'TARGET', 1, 'pending');
        const before = await db
          .select()
          .from(schema.taskSteps)
          .where(eq(schema.taskSteps.taskId, id));
        const result = await reconcileDeadTasks(db, {
          enqueueStart: async () => undefined,
          enqueueAdvance: enqueueRedrive,
          redriveRetryDelaysMs: [],
        });
        const task = await taskOf(id);
        if (leg.pin) {
          expect(result).toMatchObject({ marked: 1, revived: 0 });
          expect(task.deadAt).not.toBeNull();
          expect(task.deadReason).toContain('a custom fix target is not yet supported');
        } else {
          expect(result).toMatchObject({ marked: 0, revived: 0 });
          expect(task.deadAt).toBeNull();
        }
        expect(
          await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, id)),
        ).toEqual(before);
        expect(h.adds).toEqual([]);
      });
    });
  });
});
