import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DelayedError } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, logger, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import { ExecutionContractError } from '@haive/shared/modularity';
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
  userId: '',
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

vi.mock('../../api/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../api/src/queues.js', () => ({
  getTaskQueue: () => ({
    add: async (name: string, data: Record<string, unknown>) => h.adds.push({ name, data }),
  }),
}));
vi.mock('../../api/src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../../api/src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', h.userId);
    c.set('userRole', 'user');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Runtime cross-package seam, as in guard-api-e2e-db: exercise the real Retry route
// without adding API source to the worker's TypeScript compilation root.
const apiSource = (rel: string) => new URL(`../../api/src/${rel}`, import.meta.url).pathname;

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

const RECONCILE = '07c-ddev-reconcile';
const VALIDATE = '07b-phase-4-validate';

const applied: Record<string, number> = {};
const reviewBlocks: Record<string, boolean> = {};
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
  let template: string;
  // The current test's own copy of the template; the late editor writes to it.
  let worktree: string;
  const copies: string[] = [];
  const email = randomBytes(8).toString('hex');

  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    // One real Git template for all validation-only round controls; each writing test copies it.
    template = await mkdtemp(join(tmpdir(), 'haive-validation-only-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: template, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@test.local');
    git('config', 'user.name', 'Test');
    await writeFile(join(template, 'a.ts'), 'export const a = 1;');
    git('add', '-A');
    git('commit', '-qm', 'base');
    stub(RECONCILE, 1, LEGS[0]!.type);
    stub(VALIDATE, 2, LEGS[0]!.type);
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
    h.userId = userId;
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
        fixLoop: {
          evaluate: () =>
            reviewBlocks[leg.ids.REVIEW] === false
              ? null
              : { blocking: true, diagnosis: 'the review found a defect' },
        },
      });
      stub(leg.ids.AFTER, 2, leg.type);
      stub(`${leg.type}-late-editor`, 4, leg.type, {
        editsCodeOrTests: true,
        async apply() {
          await writeFile(join(worktree, 'a.ts'), 'export const a = 2;');
          return {};
        },
      });
    }
  });
  beforeEach(async () => {
    h.adds.length = 0;
    h.fence.mockReset();
    for (const key of Object.keys(applied)) delete applied[key];
    for (const key of Object.keys(reviewBlocks)) delete reviewBlocks[key];
    gate.held = undefined;
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
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
    for (const dir of [template, ...copies]) await rm(dir, { recursive: true, force: true });
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
        .orderBy(
          asc(schema.taskEvents.createdAt),
          // now() gives every write in one transaction the same timestamp.
          // Keep the handoff's causal order for ties instead of alphabetizing it.
          sql`case ${schema.taskEvents.eventType} when 'step.loop_back' then 0 when 'fix_loop.requested' then 1 else 2 end`,
          asc(schema.taskEvents.eventType),
        )
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

    it('a direct duplicate loop_back leaves the entered round and events unchanged', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done', { endedAt: new Date() });
      const ctx = await ctxFor(leg, id);
      const result = {
        status: 'loop_back' as const,
        row: source,
        sourceStepId: source.stepId,
        diagnosis: 'defect',
      };
      await handleResult(db, ctx, source.stepId, result);
      const before = await trace(leg, id);
      await handleResult(db, ctx, source.stepId, result);
      expect(await trace(leg, id)).toEqual(before);
      expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(1);
      expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
      expect(await eventsOf(id, 'step.loop_back')).toHaveLength(1);
    });

    it('a direct duplicate loop_back does not reoffer an already parked cap gate', async () => {
      const id = await seedTask(leg, { maxFixRounds: 0 });
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done', { endedAt: new Date() });
      const ctx = await ctxFor(leg, id);
      const result = {
        status: 'loop_back' as const,
        row: source,
        sourceStepId: source.stepId,
        diagnosis: 'defect',
      };
      await handleResult(db, ctx, source.stepId, result);
      const before = await trace(leg, id);
      const parked = await rowOf(source.id);
      expect(parked.status).toBe('waiting_form');
      await handleResult(db, ctx, source.stepId, result);
      expect(await trace(leg, id)).toEqual(before);
      expect(await rowOf(source.id)).toEqual(parked);
      expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(1);
      expect(await eventsOf(id, 'fix_loop.escalated')).toHaveLength(1);
    });

    if (!leg.pin)
      describe('atomic revise', () => {
        const revise = async (
          id: string,
          source: StepRow,
          ctx?: ResolvedTaskContext,
          self = false,
        ) =>
          handleResult(db, ctx ?? (await ctxFor(leg, id)), source.stepId, {
            status: 'revise',
            row: source,
            sourceStepId: source.stepId,
            targetStepId: self ? source.stepId : leg.ids.TARGET,
          });

        it('a superseded reset leaves no revise event or reset', async () => {
          const id = await seedTask(leg);
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
          const target = await seedRow(leg, id, 'TARGET', 1, 'done');
          const ctx = await ctxFor(leg, id);
          const read = db.query.tasks.findFirst.bind(db.query.tasks);
          const spy = vi.spyOn(db.query.tasks, 'findFirst').mockImplementationOnce((...args) => {
            const query = read(...args);
            const execute = query.execute.bind(query);
            query.execute = async () => {
              const task = await execute();
              await db
                .update(schema.tasks)
                .set({ orchestrationEpoch: BASE_EPOCH + 1 })
                .where(eq(schema.tasks.id, id));
              return task;
            };
            return query;
          });
          try {
            await revise(id, source, ctx);
            expect(await eventsOf(id, 'step.revise')).toEqual([]);
            expect(await rowOf(target.id)).toEqual(target);
            expect((await taskOf(id)).currentStepId).toBe(source.stepId);
            expect(ctx.orchestrationEpoch).toBe(BASE_EPOCH);
            expect(h.adds).toEqual([]);
          } finally {
            spy.mockRestore();
          }
        });

        it('a refused pointer rolls back the revise event and stale-row reset', async () => {
          const id = await seedTask(leg);
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
          const target = await seedRow(leg, id, 'TARGET', 1, 'done', { output: { stale: true } });
          const ctx = await ctxFor(leg, id);
          await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, id));
          const before = await taskOf(id);
          await revise(id, source, ctx);
          expect.soft(await eventsOf(id, 'step.revise')).toEqual([]);
          expect.soft(await rowOf(target.id)).toEqual(target);
          expect.soft(await taskOf(id)).toEqual(before);
          expect.soft(ctx.orchestrationEpoch).toBe(BASE_EPOCH);
          expect(h.adds).toEqual([]);
        });

        it.each([false, true])(
          'a failed revise event rolls back the reset and pointer, then replays once (self=%s)',
          async (self) => {
            const id = await seedTask(leg);
            const source = await seedRow(leg, id, 'REVIEW', 0, 'done', { endedAt: new Date() });
            const target = self
              ? source
              : await seedRow(leg, id, 'TARGET', 1, 'done', { output: { stale: true } });
            const before = await taskOf(id);
            const ctx = await ctxFor(leg, id);
            const name = `revise_${randomBytes(8).toString('hex')}`;
            await db.execute(
              sql.raw(
                `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id = '${id}' AND NEW.event_type = 'step.revise' THEN RAISE EXCEPTION USING ERRCODE = 'P7572'; END IF; RETURN NEW; END $$`,
              ),
            );
            await db.execute(
              sql.raw(
                `CREATE TRIGGER ${name} BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
              ),
            );
            try {
              await expect(revise(id, source, ctx, self)).rejects.toMatchObject({
                cause: { code: 'P7572' },
              });
              expect(await rowOf(target.id)).toEqual(target);
              expect(await taskOf(id)).toEqual(before);
              expect(await eventsOf(id, 'step.revise')).toEqual([]);
              expect(ctx.orchestrationEpoch).toBe(BASE_EPOCH);
              expect(h.adds).toEqual([]);
            } finally {
              await db.execute(sql.raw(`DROP TRIGGER ${name} ON task_events`));
              await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
            }
            await revise(id, source, ctx, self);
            expect(await rowOf(target.id)).toMatchObject({
              status: 'pending',
              output: null,
              rerunGeneration: 1,
            });
            expect(await taskOf(id)).toMatchObject({
              currentStepId: target.stepId,
              currentRound: self ? 0 : 1,
              orchestrationEpoch: BASE_EPOCH + 1,
            });
            expect(await eventsOf(id, 'step.revise')).toHaveLength(1);
            expect(h.adds).toHaveLength(1);
          },
        );

        it('a duplicate forked revise preserves the winner and records nothing', async () => {
          const id = await seedTask(leg);
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done', { endedAt: new Date() });
          const ctx = await ctxFor(leg, id);
          await revise(id, source, ctx);
          const target = await seedRow(leg, id, 'TARGET', 1, 'done', { output: { winner: true } });
          const before = await taskOf(id);
          await revise(id, source, ctx);
          expect.soft(await rowOf(target.id)).toEqual(target);
          expect.soft(await taskOf(id)).toEqual(before);
          expect.soft(await eventsOf(id, 'step.revise')).toHaveLength(1);
          expect.soft(h.adds).toHaveLength(1);
        });
      });

    if (!leg.pin)
      describe('atomic escalation', () => {
        it.each(
          ['cap', 'oscillation'].flatMap((kind) =>
            ['request', 'task', 'event'].map((cut) => ({ kind, cut })),
          ),
        )('rolls back $kind at the $cut write and replays completely', async ({ kind, cut }) => {
          const round = kind === 'cap' ? 0 : 2;
          const id = await seedTask(leg, {
            currentRound: round,
            maxFixRounds: kind === 'cap' ? 0 : 5,
          });
          const source = await seedRow(leg, id, 'REVIEW', round, 'done', { endedAt: new Date() });
          if (kind === 'oscillation') {
            await recordFixLoopRequest(db, id, source.id, {
              round: 1,
              sourceStepId: source.stepId,
              diagnosis: 'same defect',
            });
            await recordFixLoopRequest(db, id, source.id, {
              round: 2,
              sourceStepId: 'another-check',
              diagnosis: 'other defect',
            });
          }
          const beforeTask = await taskOf(id);
          const beforeRequests = await eventsOf(id, 'fix_loop.requested');
          const event = kind === 'cap' ? 'fix_loop.escalated' : 'fix_loop.oscillation_detected';
          // Fail the real SQL statement immediately after each preceding durable write.
          // The trigger is task-scoped and removed before replay, even on assertion failure.
          const name = `crash_${randomBytes(8).toString('hex')}`;
          const table = cut === 'task' ? 'tasks' : 'task_events';
          const condition =
            cut === 'task'
              ? `NEW.id = '${id}' AND NEW.status = 'waiting_user'`
              : `NEW.task_id = '${id}' AND NEW.event_type = '${cut === 'request' ? 'fix_loop.requested' : event}'`;
          await db.execute(
            sql.raw(
              `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION USING ERRCODE = 'P7571'; END IF; RETURN NEW; END $$`,
            ),
          );
          await db.execute(
            sql.raw(
              `CREATE TRIGGER ${name} BEFORE ${cut === 'task' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
            ),
          );
          const result = {
            status: 'loop_back' as const,
            row: source,
            sourceStepId: source.stepId,
            diagnosis: 'same defect',
          };
          try {
            await expect(
              handleResult(db, await ctxFor(leg, id), source.stepId, result),
            ).rejects.toMatchObject({ cause: { code: 'P7571' } });
            expect.soft(await rowOf(source.id)).toEqual(source);
            expect.soft(await taskOf(id)).toEqual(beforeTask);
            expect.soft(await eventsOf(id, 'fix_loop.requested')).toEqual(beforeRequests);
            expect.soft(await eventsOf(id, event)).toEqual([]);
            expect.soft(h.adds).toEqual([]);
          } finally {
            await db.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
            await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
          }
          await handleResult(db, await ctxFor(leg, id), source.stepId, result);
          expect(await rowOf(source.id)).toMatchObject({
            status: 'waiting_form',
            endedAt: null,
            waitingStartedAt: expect.any(Date),
          });
          expect(await taskOf(id)).toMatchObject({
            status: 'waiting_user',
            currentStepId: source.stepId,
            currentRound: round,
          });
          expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(beforeRequests.length + 1);
          expect(await eventsOf(id, event)).toHaveLength(1);
          await resolveFixLoopGate(
            db,
            await ctxFor(leg, id),
            await rowOf(source.id),
            'continue',
            round,
            '',
          );
          expect(await taskOf(id)).toMatchObject({
            currentStepId: leg.ids.TARGET,
            currentRound: round + 1,
          });
        });
      });

    if (!leg.pin)
      it('two interleaved loop_back passes enter the fix round only once', async () => {
        const id = await seedTask(leg);
        const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
        const ctx = await ctxFor(leg, id);
        const result = {
          status: 'loop_back' as const,
          row: source,
          sourceStepId: source.stepId,
          diagnosis: 'defect',
        };
        // Both real hand-offs must pass their unlocked guard before either transaction
        // starts. PostgreSQL then serializes them on the same real source-row lock.
        const refused = vi.spyOn(logger, 'info');
        const bothReady = Promise.withResolvers<void>();
        const transaction = db.transaction.bind(db);
        let arrivals = 0;
        const spy = vi.spyOn(db, 'transaction').mockImplementation(async (...args) => {
          arrivals += 1;
          if (arrivals === 2) bothReady.resolve();
          await bothReady.promise;
          return transaction(...args);
        });
        try {
          await Promise.all([
            handleResult(db, { ...ctx }, source.stepId, result),
            handleResult(db, { ...ctx }, source.stepId, result),
          ]);
          expect(refused).toHaveBeenCalledExactlyOnceWith(
            {
              taskId: id,
              stepId: source.stepId,
              round: 0,
              reason: 'task_pointer_moved_under_lock',
            },
            expect.any(String),
          );
          expect(arrivals).toBe(2);
          expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(1);
          expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
          expect(await eventsOf(id, 'step.loop_back')).toHaveLength(1);
          expect(h.adds).toHaveLength(1);
          expect(await taskOf(id)).toMatchObject({
            currentStepId: leg.ids.TARGET,
            currentRound: 1,
            orchestrationEpoch: BASE_EPOCH,
          });
        } finally {
          spy.mockRestore();
          refused.mockRestore();
        }
      });

    it('a losing loop_back cannot reset the target created by the winner', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      const ctx = await ctxFor(leg, id);
      const result = {
        status: 'loop_back' as const,
        row: source,
        sourceStepId: source.stepId,
        diagnosis: 'defect',
      };
      const guardRead = Promise.withResolvers<void>();
      const resumeLoser = Promise.withResolvers<void>();
      const targetRunning = Promise.withResolvers<void>();
      const finishTarget = Promise.withResolvers<void>();
      const findFirst = db.query.tasks.findFirst.bind(db.query.tasks);
      const read = vi
        .spyOn(db.query.tasks, 'findFirst')
        // The epoch read precedes the unlocked pointer/park guard.
        .mockImplementationOnce(findFirst)
        .mockImplementationOnce((...args) => {
          const query = findFirst(...args);
          const execute = query.execute.bind(query);
          // Preserve Drizzle's query builder and delay only its actual execution.
          query.execute = async () => {
            const row = await execute();
            guardRead.resolve();
            await resumeLoser.promise;
            return row;
          };
          return query;
        });
      const target = stepRegistry.require(leg.ids.TARGET);
      const apply = target.apply.bind(target);
      const applying = vi.spyOn(target, 'apply').mockImplementation(async (...args) => {
        targetRunning.resolve();
        await finishTarget.promise;
        return apply(...args);
      });
      const refused = vi.spyOn(logger, 'info');
      const loser = handleResult(db, { ...ctx }, source.stepId, result);
      let winnerAdvance: Promise<void> | undefined;
      try {
        await guardRead.promise;
        // The loser retains the source pointer it read before the winner commits.
        await handleResult(db, { ...ctx }, source.stepId, result);
        winnerAdvance = processTaskJob(advance(leg, id, 'TARGET', 1, BASE_EPOCH));
        await targetRunning.promise;
        const running = await db.query.taskSteps.findFirst({
          where: and(
            eq(schema.taskSteps.taskId, id),
            eq(schema.taskSteps.stepId, leg.ids.TARGET),
            eq(schema.taskSteps.round, 1),
          ),
        });
        expect(running?.status).toBe('running');
        resumeLoser.resolve();
        await loser;
        expect(refused).toHaveBeenCalledExactlyOnceWith(
          { taskId: id, stepId: source.stepId, round: 0, reason: 'task_pointer_moved_under_lock' },
          expect.any(String),
        );
        expect(await taskOf(id)).toMatchObject({
          currentStepId: leg.ids.TARGET,
          currentRound: 1,
          orchestrationEpoch: BASE_EPOCH,
        });
        expect(await rowOf(running!.id)).toEqual(running);
        expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(1);
        expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
        expect(h.adds).toHaveLength(1);
      } finally {
        resumeLoser.resolve();
        finishTarget.resolve();
        try {
          await Promise.all([loser, winnerAdvance]);
        } finally {
          read.mockRestore();
          applying.mockRestore();
          refused.mockRestore();
        }
      }
      expect((await taskOf(id)).currentStepId).toBe(leg.ids.REVIEW);
      expect(h.adds.at(-1)?.data).toMatchObject({ round: 1, epoch: BASE_EPOCH });
    });

    it('loop_back resets stale next-round rows and enqueues at the bumped epoch', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      const target = await seedRow(leg, id, 'TARGET', 1, 'done', { output: { stale: true } });
      const review = await seedRow(leg, id, 'REVIEW', 1, 'done', { output: { stale: true } });
      const ctx = await ctxFor(leg, id);
      await handleResult(db, ctx, source.stepId, {
        status: 'loop_back',
        row: source,
        sourceStepId: source.stepId,
        diagnosis: 'defect',
      });
      for (const row of [target, review])
        expect(await rowOf(row.id)).toMatchObject({
          status: 'pending',
          output: null,
          rerunGeneration: 1,
        });
      expect(await rowOf(source.id)).toEqual(source);
      expect(await taskOf(id)).toMatchObject({
        currentStepId: leg.ids.TARGET,
        currentRound: 1,
        orchestrationEpoch: BASE_EPOCH + 1,
      });
      expect(ctx.orchestrationEpoch).toBe(BASE_EPOCH + 1);
      expect(h.adds).toEqual([
        {
          name: TASK_JOB_NAMES.ADVANCE_STEP,
          data: expect.objectContaining({
            stepId: leg.ids.TARGET,
            round: 1,
            epoch: BASE_EPOCH + 1,
          }),
        },
      ]);
      expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(1);
      expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
    });

    it('a Stop rolls back the stale next-round reset when the task write refuses', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      const target = await seedRow(leg, id, 'TARGET', 1, 'done', { output: { stale: true } });
      const review = await seedRow(leg, id, 'REVIEW', 1, 'done', { output: { stale: true } });
      const ctx = await ctxFor(leg, id);
      // A crash-left live invocation lets the real Stop fail the task while leaving
      // these finished rows alone; Stop does not move the task epoch.
      await db.insert(schema.cliInvocations).values({
        taskId: id,
        taskStepId: source.id,
        mode: 'cli',
        prompt: 'crash-left run',
      });
      const { stopActiveCliInvocations } = await import(apiSource('lib/task-control.ts'));
      expect(await stopActiveCliInvocations(db, id, { failTask: true })).toMatchObject({
        cancelled: 1,
        stopped: 0,
        failedAt: expect.any(String),
      });
      const stopped = await taskOf(id);
      expect(stopped).toMatchObject({ status: 'failed', orchestrationEpoch: BASE_EPOCH });
      const refused = vi.spyOn(logger, 'info');
      try {
        await handleResult(db, ctx, source.stepId, {
          status: 'loop_back',
          row: source,
          sourceStepId: source.stepId,
          diagnosis: 'defect',
        });
        expect(await rowOf(target.id)).toEqual(target);
        expect(await rowOf(review.id)).toEqual(review);
        expect(await rowOf(source.id)).toEqual(source);
        expect(await taskOf(id)).toEqual(stopped);
        expect(ctx.orchestrationEpoch).toBe(BASE_EPOCH);
        expect(h.adds).toEqual([]);
        expect(await eventsOf(id, 'fix_loop.requested')).toEqual([]);
        expect(await eventsOf(id, 'fix_loop.started')).toEqual([]);
        expect(refused).toHaveBeenCalledExactlyOnceWith(
          { taskId: id, stepId: source.stepId, round: 0, reason: 'task_write_refused' },
          expect.any(String),
        );
      } finally {
        refused.mockRestore();
      }
    });

    it('a lost source rolls back the stale next-round reset', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      const target = await seedRow(leg, id, 'TARGET', 1, 'done');
      const review = await seedRow(leg, id, 'REVIEW', 1, 'done');
      const ctx = await ctxFor(leg, id);
      // Retry writes the source before moving the task epoch.
      await db
        .update(schema.taskSteps)
        .set({ status: 'pending' })
        .where(eq(schema.taskSteps.id, source.id));
      const refused = vi.spyOn(logger, 'info');
      try {
        await handleResult(db, ctx, source.stepId, {
          status: 'loop_back',
          row: source,
          sourceStepId: source.stepId,
          diagnosis: 'defect',
        });
        expect(await rowOf(target.id)).toEqual(target);
        expect(await rowOf(review.id)).toEqual(review);
        expect((await rowOf(source.id)).status).toBe('pending');
        expect(await taskOf(id)).toMatchObject({
          currentStepId: source.stepId,
          currentRound: 0,
          orchestrationEpoch: BASE_EPOCH,
        });
        expect(ctx.orchestrationEpoch).toBe(BASE_EPOCH);
        expect(h.adds).toEqual([]);
        expect(await eventsOf(id, 'fix_loop.requested')).toEqual([]);
        expect(await eventsOf(id, 'fix_loop.started')).toEqual([]);
        expect(refused).toHaveBeenCalledExactlyOnceWith(
          { taskId: id, stepId: source.stepId, round: 0, reason: 'source_not_owned' },
          expect.any(String),
        );
      } finally {
        refused.mockRestore();
      }
    });

    it('a null task pointer is not evidence of a move, including under the source lock', async () => {
      const id = await seedTask(leg, { currentStepId: null, currentRound: 42 });
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      await loopBack(id, source, 'defect');
      expect(await taskOf(id)).toMatchObject({
        currentStepId: leg.ids.TARGET,
        currentRound: 1,
        orchestrationEpoch: BASE_EPOCH,
      });
      expect(await eventsOf(id, 'fix_loop.requested')).toHaveLength(1);
      expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
      expect(h.adds).toHaveLength(1);
    });

    it('logs only task_missing_under_lock when the locked task read finds nothing', async () => {
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      const target = await seedRow(leg, id, 'TARGET', 1, 'done');
      const review = await seedRow(leg, id, 'REVIEW', 1, 'done');
      const transaction = db.transaction.bind(db);
      const logged = vi.spyOn(logger, 'info');
      // Deleting a real task cascades its source, failing lockOwnedStep first. Inject
      // the missing read only inside the transaction, after taking the real row lock.
      const spy = vi.spyOn(db, 'transaction').mockImplementation((callback, config) =>
        transaction(async (tx) => {
          const read = vi.spyOn(tx.query.tasks, 'findFirst').mockResolvedValueOnce(undefined);
          try {
            return await callback(tx);
          } finally {
            read.mockRestore();
          }
        }, config),
      );
      try {
        await loopBack(id, source, 'defect');
        expect(logged).toHaveBeenCalledExactlyOnceWith(
          { taskId: id, stepId: source.stepId, round: 0, reason: 'task_missing_under_lock' },
          expect.any(String),
        );
        expect(await eventsOf(id, 'fix_loop.requested')).toEqual([]);
        expect(await eventsOf(id, 'fix_loop.started')).toEqual([]);
        expect(h.adds).toEqual([]);
        expect(await rowOf(target.id)).toEqual(target);
        expect(await rowOf(review.id)).toEqual(review);
        expect(await taskOf(id)).toMatchObject({
          currentStepId: source.stepId,
          currentRound: 0,
          orchestrationEpoch: BASE_EPOCH,
        });
      } finally {
        spy.mockRestore();
        logged.mockRestore();
      }
    });

    if (!leg.pin)
      it.each(['task_missing', 'task_pointer_moved', 'task_round_moved', 'source_parked'])(
        'logs the %s loop_back refusal without writing events',
        async (refusal) => {
          const id = await seedTask(leg);
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
          const ctx = await ctxFor(leg, id);
          if (refusal === 'task_missing')
            await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
          else if (refusal === 'source_parked')
            await db
              .update(schema.taskSteps)
              .set({ status: 'waiting_form' })
              .where(eq(schema.taskSteps.id, source.id));
          else
            await db
              .update(schema.tasks)
              .set(
                refusal === 'task_round_moved'
                  ? { currentRound: 1 }
                  : { currentStepId: leg.ids.TARGET },
              )
              .where(eq(schema.tasks.id, id));
          const logged = vi.spyOn(logger, 'info');
          try {
            await handleResult(db, ctx, source.stepId, {
              status: 'loop_back',
              row: source,
              sourceStepId: source.stepId,
              diagnosis: 'defect',
            });
            expect(logged).toHaveBeenCalledWith(
              {
                taskId: id,
                stepId: source.stepId,
                round: 0,
                reason: refusal === 'task_round_moved' ? 'task_pointer_moved' : refusal,
              },
              expect.any(String),
            );
            expect(await eventsOf(id)).toEqual([]);
            expect(h.adds).toEqual([]);
          } finally {
            logged.mockRestore();
          }
        },
      );

    if (!leg.pin)
      describe('Retry into a validation-only next round', () => {
        const rewoundValidation = async (reconcile: boolean, cap = 0, revise = false) => {
          const editor = `${leg.type}-late-editor`;
          const checks = [...(reconcile ? [RECONCILE] : []), VALIDATE];
          const runListSnapshot = [
            leg.ids.TARGET,
            ...checks,
            leg.ids.REVIEW,
            editor,
            leg.ids.AFTER,
          ];
          const id = await seedTask(leg, {
            currentStepId: editor,
            runListSnapshot,
            maxFixRounds: cap,
          });
          // Round 0 already validated the base tree. The late editor changes it during apply.
          worktree = await mkdtemp(join(tmpdir(), 'haive-validation-only-'));
          copies.push(worktree);
          await cp(template, worktree, { recursive: true });
          await db.insert(schema.taskSteps).values({
            taskId: id,
            stepId: '01-worktree-setup',
            title: 'Worktree setup',
            stepIndex: -1,
            runSeq: -1,
            round: 0,
            status: 'done',
            output: { worktreePath: worktree, baseBranch: 'main' },
          });
          const { readValidationSnapshot } =
            await import('../src/step-engine/steps/workflow/_validation-snapshot.js');
          const before = await readValidationSnapshot({ db, taskId: id });
          expect(before).not.toBeNull();
          await db.insert(schema.taskSteps).values({
            taskId: id,
            stepId: VALIDATE,
            title: 'Validation',
            stepIndex: 2,
            runSeq: runListSnapshot.indexOf(VALIDATE),
            round: 0,
            status: 'done',
            output: { validationSnapshot: before },
          });
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done', {
            runSeq: runListSnapshot.indexOf(leg.ids.REVIEW),
          });
          const run = async (stepId: string, round: number) =>
            processTaskJob(
              job(TASK_JOB_NAMES.ADVANCE_STEP, {
                taskId: id,
                userId,
                stepId,
                round,
                epoch: (await taskOf(id)).orchestrationEpoch,
              }),
            );
          await run(editor, 0);
          expect(await eventsOf(id, 'validation.recheck_requested')).toHaveLength(1);
          expect(await taskOf(id)).toMatchObject({ currentStepId: checks[0], currentRound: 1 });
          for (const check of checks) await run(check, 1);
          const roundRows = () =>
            db.query.taskSteps.findMany({
              where: and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.round, 1)),
              orderBy: [asc(schema.taskSteps.runSeq)],
            });
          expect((await roundRows()).map((r) => [r.stepId, r.status])).toEqual(
            checks.map((check) => [check, 'done']),
          );
          expect((await taskOf(id)).currentStepId).toBe(leg.ids.AFTER);
          // Real Retry rewinds only round 0, leaving round 1's checks and no target row.
          const { taskRoutes } = await import(apiSource('routes/tasks/index.ts'));
          const { errorHandler } = await import(apiSource('middleware/error-handler.ts'));
          taskRoutes.onError(errorHandler);
          const retry = await taskRoutes.request(`/${id}/steps/${leg.ids.REVIEW}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'retry', round: 0 }),
          });
          expect(retry.status, await retry.text()).toBe(200);
          expect(await taskOf(id)).toMatchObject({
            currentStepId: leg.ids.REVIEW,
            currentRound: 0,
            orchestrationEpoch: BASE_EPOCH + 1,
          });
          expect((await roundRows()).map((r) => [r.stepId, r.status])).toEqual(
            checks.map((check) => [check, 'done']),
          );
          const review = stepRegistry.require(leg.ids.REVIEW);
          if (revise)
            stepRegistry.override({
              ...review,
              fixLoop: undefined,
              reviseLoop: { evaluate: () => ({ targetStepId: leg.ids.TARGET }) },
            });
          try {
            await run(leg.ids.REVIEW, 0);
          } finally {
            if (revise) stepRegistry.override(review);
          }
          return { id, checks, source: await rowOf(source.id), roundRows, run };
        };

        it('revise reruns the validation-only downstream rows after Retry', async () => {
          const { id, checks, roundRows, run } = await rewoundValidation(true, 0, true);
          expect
            .soft((await roundRows()).map((r) => [r.stepId, r.status, r.output, r.rerunGeneration]))
            .toEqual(checks.map((id) => [id, 'pending', null, 1]));
          expect.soft((await taskOf(id)).orchestrationEpoch).toBe(BASE_EPOCH + 2);
          await run(leg.ids.TARGET, 1);
          for (const check of checks) await run(check, 1);
          for (const check of checks) expect.soft(applied[check]).toBe(2);
        });

        it.each([true, false])(
          'Continue reruns checks without a target row (07c=%s)',
          async (reconcile) => {
            const { id, checks, source, roundRows, run } = await rewoundValidation(reconcile);
            expect(source.status).toBe('waiting_form');
            const ctx = await ctxFor(leg, id);
            await resolveFixLoopGate(db, ctx, source, 'continue', 0, '');
            expect
              .soft(
                (await roundRows()).map((r) => ({
                  step: r.stepId,
                  status: r.status,
                  output: r.output,
                  generation: r.rerunGeneration,
                })),
              )
              .toEqual(
                checks.map((step) => ({ step, status: 'pending', output: null, generation: 1 })),
              );
            expect.soft(ctx.orchestrationEpoch).toBe(BASE_EPOCH + 2);
            await run(leg.ids.TARGET, 1);
            expect(applied[leg.ids.TARGET]).toBe(1);
            for (const check of checks) await run(check, 1);
            // On unchanged code, both done checks are reused: neither apply runs again.
            for (const check of checks) expect.soft(applied[check]).toBe(2);
          },
        );

        it.each([true, false])(
          'loop_back reruns checks without a target row (07c=%s)',
          async (reconcile) => {
            // A positive allowance takes direct loop_back instead of the Continue gate.
            const { id, checks, source, roundRows, run } = await rewoundValidation(reconcile, 1);
            expect(source.status).toBe('done');
            expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
            expect(await eventsOf(id, 'fix_loop.escalated')).toHaveLength(0);
            expect
              .soft(
                (await roundRows()).map((r) => ({
                  step: r.stepId,
                  status: r.status,
                  output: r.output,
                  generation: r.rerunGeneration,
                })),
              )
              .toEqual(
                checks.map((step) => ({ step, status: 'pending', output: null, generation: 1 })),
              );
            expect.soft((await taskOf(id)).orchestrationEpoch).toBe(BASE_EPOCH + 2);
            await run(leg.ids.TARGET, 1);
            expect(applied[leg.ids.TARGET]).toBe(1);
            for (const check of checks) await run(check, 1);
            for (const check of checks) expect.soft(applied[check]).toBe(2);
          },
        );

        it('two Continue passes reset a validation-only round once', async () => {
          const { id, checks, source, roundRows, run } = await rewoundValidation(true);
          const ctx = await ctxFor(leg, id);
          h.adds.length = 0;
          const bothReady = Promise.withResolvers<void>();
          const transaction = db.transaction.bind(db);
          let arrivals = 0;
          const spy = vi.spyOn(db, 'transaction').mockImplementation(async (...args) => {
            if (++arrivals === 2) bothReady.resolve();
            await bothReady.promise;
            return transaction(...args);
          });
          try {
            await Promise.all([
              resolveFixLoopGate(db, { ...ctx }, source, 'continue', 0, ''),
              resolveFixLoopGate(db, { ...ctx }, source, 'continue', 0, ''),
            ]);
          } finally {
            spy.mockRestore();
          }
          expect(arrivals).toBe(2);
          expect((await roundRows()).map((r) => [r.stepId, r.status, r.rerunGeneration])).toEqual(
            checks.map((check) => [check, 'pending', 1]),
          );
          expect(await taskOf(id)).toMatchObject({
            currentStepId: leg.ids.TARGET,
            currentRound: 1,
            orchestrationEpoch: ctx.orchestrationEpoch + 1,
          });
          expect(await eventsOf(id, 'fix_loop.continued')).toHaveLength(1);
          expect(h.adds).toHaveLength(1);
          await run(leg.ids.TARGET, 1);
          for (const check of checks) await run(check, 1);
          for (const check of checks) expect(applied[check]).toBe(2);
        });

        it('Stop after the validation-only reset refuses its queued advance', async () => {
          const { id, checks, source, roundRows } = await rewoundValidation(true);
          await resolveFixLoopGate(db, await ctxFor(leg, id), source, 'continue', 0, '');
          const fresh = await roundRows();
          expect(fresh.map((r) => [r.stepId, r.status, r.rerunGeneration])).toEqual(
            checks.map((check) => [check, 'pending', 1]),
          );
          const queued = h.adds.at(-1)!;
          // A crash-left invocation makes Stop applicable even before the new
          // target row exists. Stop commits after the reset and keeps the epoch.
          await db
            .insert(schema.cliInvocations)
            .values({ taskId: id, taskStepId: source.id, mode: 'cli', prompt: 'crash-left run' });
          const { stopActiveCliInvocations } = await import(apiSource('lib/task-control.ts'));
          expect(await stopActiveCliInvocations(db, id, { failTask: true })).toMatchObject({
            cancelled: 1,
            failedAt: expect.any(String),
          });
          const stopped = await taskOf(id);
          expect(stopped.status).toBe('failed');
          await processTaskJob(job(queued.name, queued.data));
          expect(await taskOf(id)).toEqual(stopped);
          expect(await roundRows()).toEqual(fresh);
          expect(applied[leg.ids.TARGET]).toBeUndefined();
          for (const check of checks) expect(applied[check]).toBe(1);
        });

        it.each(['stale_epoch', 'lost_source', 'unavailable_cli'])(
          'Continue preserves a validation-only round on %s',
          async (refusal) => {
            const { id, source, roundRows } = await rewoundValidation(true);
            const ctx = await ctxFor(leg, id);
            if (refusal === 'stale_epoch')
              await db
                .update(schema.tasks)
                .set({ orchestrationEpoch: ctx.orchestrationEpoch + 1 })
                .where(eq(schema.tasks.id, id));
            if (refusal === 'lost_source')
              await db
                .update(schema.taskSteps)
                .set({ status: 'pending' })
                .where(eq(schema.taskSteps.id, source.id));
            const rowsBefore = await roundRows();
            const taskBefore = await taskOf(id);
            const sourceBefore = await rowOf(source.id);
            const eventsBefore = await eventsOf(id);
            h.adds.length = 0;
            await resolveFixLoopGate(
              db,
              ctx,
              source,
              'continue',
              0,
              '',
              refusal === 'unavailable_cli' ? randomUUID() : undefined,
            );
            expect(await roundRows()).toEqual(rowsBefore);
            expect(await eventsOf(id)).toEqual(eventsBefore);
            expect(await taskOf(id)).toMatchObject({
              status: taskBefore.status,
              currentStepId: taskBefore.currentStepId,
              currentRound: taskBefore.currentRound,
              orchestrationEpoch: taskBefore.orchestrationEpoch,
            });
            if (refusal === 'unavailable_cli')
              expect(await rowOf(source.id)).toMatchObject({
                status: 'waiting_form',
                formValues: null,
              });
            else expect(await rowOf(source.id)).toEqual(sourceBefore);
            expect(h.adds).toEqual([]);
          },
        );
      });

    if (!leg.pin)
      describe('Retry of an earlier source card', () => {
        const rewoundGate = async () => {
          const id = await seedTask(leg, { maxFixRounds: 1 });
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
          await loopBack(id, source, 'the original defect');
          // Real execution creates terminal TARGET@1 and REVIEW@1, leaving AFTER current.
          reviewBlocks[leg.ids.REVIEW] = false;
          await processTaskJob(advance(leg, id, 'TARGET', 1, BASE_EPOCH));
          await processTaskJob(advance(leg, id, 'REVIEW', 1, BASE_EPOCH));
          const roundRow = async (role: Role) =>
            (await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, id),
                eq(schema.taskSteps.stepId, leg.ids[role]),
                eq(schema.taskSteps.round, 1),
              ),
            }))!;
          expect((await roundRow('TARGET')).status).toBe('done');
          expect((await roundRow('REVIEW')).status).toBe('done');
          expect((await taskOf(id)).currentStepId).toBe(leg.ids.AFTER);
          const { taskRoutes } = await import(apiSource('routes/tasks/index.ts'));
          const { errorHandler } = await import(apiSource('middleware/error-handler.ts'));
          taskRoutes.onError(errorHandler);
          const retry = await taskRoutes.request(`/${id}/steps/${leg.ids.REVIEW}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'retry', round: 0 }),
          });
          expect(retry.status, await retry.text()).toBe(200);
          const rewound = await taskOf(id);
          expect(rewound.currentRound).toBe(0);
          expect(rewound.orchestrationEpoch).toBe(BASE_EPOCH + 1);
          expect((await roundRow('TARGET')).status).toBe('done');
          expect((await roundRow('REVIEW')).status).toBe('done');
          reviewBlocks[leg.ids.REVIEW] = true;
          await processTaskJob(advance(leg, id, 'REVIEW', 0, rewound.orchestrationEpoch));
          const gateRow = await rowOf(source.id);
          expect(gateRow.status).toBe('waiting_form');
          return { id, source, roundRow, rewound, gateRow };
        };

        it('Continue reruns terminal next-round rows', async () => {
          const { id, roundRow, rewound, gateRow } = await rewoundGate();
          await resolveFixLoopGate(db, await ctxFor(leg, id), gateRow, 'continue', 0, '');
          const continued = await taskOf(id);
          await processTaskJob(advance(leg, id, 'TARGET', 1, continued.orchestrationEpoch));
          // A fresh implementation must run; unchanged code walks past TARGET@1 done.
          expect(applied[leg.ids.TARGET]).toBe(2);
          expect((await roundRow('TARGET')).rerunGeneration).toBe(1);
          expect((await roundRow('REVIEW')).status).toBe('pending');
          expect((await roundRow('REVIEW')).output).toBeNull();
          expect(continued.orchestrationEpoch).toBe(rewound.orchestrationEpoch + 1);
        });

        it('an unavailable CLI reoffers the gate without resetting the later round', async () => {
          const { id, roundRow, rewound, gateRow } = await rewoundGate();
          const targetBefore = await roundRow('TARGET');
          const reviewBefore = await roundRow('REVIEW');
          const eventsBefore = await eventsOf(id);
          h.adds.length = 0;
          const ctx = await ctxFor(leg, id);
          await resolveFixLoopGate(
            db,
            ctx,
            gateRow,
            'continue',
            0,
            'try another fix',
            randomUUID(),
          );
          expect(await roundRow('TARGET')).toEqual(targetBefore);
          expect(await roundRow('REVIEW')).toEqual(reviewBefore);
          expect(await eventsOf(id)).toEqual(eventsBefore);
          expect((await rowOf(gateRow.id)).status).toBe('waiting_form');
          expect((await taskOf(id)).orchestrationEpoch).toBe(rewound.orchestrationEpoch);
          expect(ctx.orchestrationEpoch).toBe(rewound.orchestrationEpoch);
          expect(h.adds).toEqual([]);
        });

        it('a stale epoch rolls back the next-round reset and leaves the answer unapplied', async () => {
          const { id, roundRow, gateRow } = await rewoundGate();
          const targetBefore = await roundRow('TARGET');
          const reviewBefore = await roundRow('REVIEW');
          const eventsBefore = await eventsOf(id);
          const ctx = await ctxFor(leg, id);
          await db
            .update(schema.tasks)
            .set({ orchestrationEpoch: ctx.orchestrationEpoch + 1 })
            .where(eq(schema.tasks.id, id));
          h.adds.length = 0;
          await resolveFixLoopGate(db, ctx, gateRow, 'continue', 0, '');
          expect(await roundRow('TARGET')).toEqual(targetBefore);
          expect(await roundRow('REVIEW')).toEqual(reviewBefore);
          expect(await rowOf(gateRow.id)).toEqual(gateRow);
          expect(await eventsOf(id)).toEqual(eventsBefore);
          expect(h.adds).toEqual([]);
        });

        it('a lost source row rolls back the next-round reset', async () => {
          const { id, roundRow, gateRow } = await rewoundGate();
          const targetBefore = await roundRow('TARGET');
          const reviewBefore = await roundRow('REVIEW');
          const taskBefore = await taskOf(id);
          const eventsBefore = await eventsOf(id);
          await db
            .update(schema.taskSteps)
            .set({ status: 'pending' })
            .where(eq(schema.taskSteps.id, gateRow.id));
          h.adds.length = 0;
          await resolveFixLoopGate(db, await ctxFor(leg, id), gateRow, 'continue', 0, '');
          expect(await roundRow('TARGET')).toEqual(targetBefore);
          expect(await roundRow('REVIEW')).toEqual(reviewBefore);
          expect(await taskOf(id)).toEqual(taskBefore);
          expect(await eventsOf(id)).toEqual(eventsBefore);
          expect(h.adds).toEqual([]);
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

      if (!leg.pin)
        it('recovers a real committed loop_back whose enqueue was lost', async () => {
          const id = await seedTask(leg);
          const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
          const { Queue } = await import('bullmq');
          const lost = new Error('injected lost enqueue');
          const add = vi.spyOn(Queue.prototype, 'add').mockRejectedValueOnce(lost);
          try {
            await expect(loopBack(id, source, 'durable diagnosis')).rejects.toBe(lost);
          } finally {
            add.mockRestore();
          }
          expect(h.adds).toEqual([]);
          expect(await taskOf(id)).toMatchObject({
            currentStepId: leg.ids.TARGET,
            currentRound: 1,
          });
          const requests = await eventsOf(id, 'fix_loop.requested');
          expect(requests).toHaveLength(1);
          await twice();
          expect(h.adds).toHaveLength(1);
          expect(h.adds[0]!.data).toMatchObject({
            stepId: leg.ids.TARGET,
            round: 1,
            epoch: BASE_EPOCH + 1,
          });
          await processTaskJob(job(h.adds[0]!.name, h.adds[0]!.data));
          expect(applied[leg.ids.TARGET]).toBe(1);
          expect(await eventsOf(id, 'fix_loop.requested')).toEqual(requests);
          expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
        });

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

      describe('agent work behind the target row', () => {
        const startedRound = async (over: Partial<typeof schema.taskSteps.$inferInsert> = {}) => {
          const id = await seedTask(leg, { currentStepId: leg.ids.TARGET, currentRound: 1 });
          await entered(id, (await seedRow(leg, id, 'REVIEW', 0, 'done')).id);
          const row = await seedRow(leg, id, 'TARGET', 1, 'running', {
            startedAt: new Date(),
            ...over,
          });
          return { id, row };
        };
        const seedInvocation = async (
          taskId: string,
          taskStepId: string,
          over: Partial<typeof schema.cliInvocations.$inferInsert> = {},
        ) => {
          const [made] = await db
            .insert(schema.cliInvocations)
            .values({ taskId, taskStepId, mode: 'cli', prompt: 'fix', ...over })
            .returning();
          return made!;
        };
        const invocationsOf = (taskId: string) =>
          db
            .select()
            .from(schema.cliInvocations)
            .where(eq(schema.cliInvocations.taskId, taskId))
            .orderBy(asc(schema.cliInvocations.createdAt));
        // A cli-exec job carries the invocation it owes a run; an advance does not.
        const cliExecJobs = () => h.adds.filter((a) => 'invocationId' in a.data);
        // Boot with agent work behind the row: it is a parked step, so each boot fences the task and
        // re-drives it again (the earlier advance is left stale by the epoch bump). What must hold is
        // that no boot records a run or queues one.
        const bootTwice = async (taskId: string) => {
          const before = await invocationsOf(taskId);
          await boot();
          expect(await invocationsOf(taskId)).toHaveLength(before.length);
          expect(cliExecJobs()).toEqual([]);
          await boot();
          expect(await invocationsOf(taskId)).toHaveLength(before.length);
          expect(cliExecJobs()).toEqual([]);
          expect(h.adds.every((a) => a.name === TASK_JOB_NAMES.ADVANCE_STEP)).toBe(true);
        };
        const parkedGolden = {
          task: { step: 'TARGET', round: 1, status: 'running', epoch: 2, dead: false },
          rows: ['REVIEW@0:done', 'TARGET@1:waiting_cli'],
          events: ['fix_loop.requested', 'fix_loop.started'],
          jobs: ['advance-step:TARGET@1+1', 'advance-step:TARGET@1+2'],
          applies: {},
        };

        it('a running row with a live run is demoted and recovered, its run ended, never replaced', async () => {
          const { id, row } = await startedRound();
          const run = await seedInvocation(id, row.id, { startedAt: new Date() });
          await bootTwice(id);
          verdict('S6-live-run', leg, await trace(leg, id), parkedGolden);
          const [after] = await invocationsOf(id);
          expect(after!.id).toBe(run.id);
          expect(after!.endedAt).not.toBeNull();
          expect(after!.supersededAt).toBeNull();
          expect(after!.consumedAt).toBeNull();
          const kept = await rowOf(row.id);
          expect(kept.startedAt).not.toBeNull();
          expect(kept.endedAt).toBeNull();
        });

        it('a running row whose loop pass finished and has no run is kept, not reset', async () => {
          const { id, row } = await startedRound({ iterationCount: 2 });
          await bootTwice(id);
          expect(await invocationsOf(id)).toEqual([]);
          verdict('S6-finished-pass', leg, await trace(leg, id), parkedGolden);
          const kept = await rowOf(row.id);
          expect(kept.iterationCount).toBe(2);
          expect(kept.startedAt).not.toBeNull();
        });

        it('a running row whose only run was superseded has no CLI work: reset, one advance', async () => {
          const { id, row } = await startedRound();
          const now = new Date();
          await seedInvocation(id, row.id, {
            startedAt: now,
            endedAt: now,
            supersededAt: now,
            errorMessage: 'superseded by an earlier reset',
          });
          const before = await invocationsOf(id);
          await twice();
          expect(cliExecJobs()).toEqual([]);
          verdict('S6-superseded-run', leg, await trace(leg, id), {
            task: { step: 'TARGET', round: 1, status: 'running', epoch: 1, dead: false },
            rows: ['REVIEW@0:done', 'TARGET@1:pending'],
            events: ['fix_loop.requested', 'fix_loop.started'],
            jobs: ['advance-step:TARGET@1+1'],
            applies: {},
          });
          expect(await invocationsOf(id)).toEqual(before);
        });

        it('a parked row whose run ended with its result unconsumed is re-driven, the run untouched', async () => {
          const { id, row } = await startedRound({ status: 'waiting_cli' });
          const now = new Date();
          await seedInvocation(id, row.id, {
            startedAt: now,
            endedAt: now,
            exitCode: 0,
            parsedOutput: { done: true },
          });
          const before = await invocationsOf(id);
          await bootTwice(id);
          verdict('S6-ended-unconsumed', leg, await trace(leg, id), parkedGolden);
          expect(await invocationsOf(id)).toEqual(before);
          expect(before[0]!.consumedAt).toBeNull();
        });
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
          expect(task.deadReason).toContain(new ExecutionContractError('refused').code);
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

  describe('custom leg with the target module deactivated', () => {
    const leg = LEGS[1]!;
    const deactivate = () =>
      db.insert(schema.modules).values({
        moduleId: 'cfr-fix',
        packageName: '@haive/module-cfr-fix',
        name: 'cfr-fix',
        installedVersion: '1.0.0',
        deactivatedAt: new Date(),
      });
    afterEach(async () => {
      await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'cfr-fix'));
    });
    const loopBack = async (taskId: string, row: StepRow) =>
      handleResult(db, await ctxFor(leg, taskId), row.stepId, {
        status: 'loop_back',
        row,
        diagnosis: 'defect',
        sourceStepId: row.stepId,
      });
    const refusedBefore = async (id: string) => {
      const t = await taskOf(id);
      expect(t.status).toBe('failed');
      expect(t.orchestrationEpoch).toBe(BASE_EPOCH);
      expect(t.errorMessage).toContain(`fix loop target ${customTarget}`);
      expect(t.errorMessage).toContain('cfr-fix');
      const types = (await eventsOf(id)).map((e) => e.eventType);
      expect(types).toContain('fix_loop.unroutable');
      expect(types).not.toContain('fix_loop.requested');
      expect(types).not.toContain('fix_loop.started');
      expect(types).not.toContain('fix_loop.continued');
      expect(
        await db
          .select()
          .from(schema.taskSteps)
          .where(and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.round, 1))),
      ).toEqual([]);
      expect(h.adds).toEqual([]);
    };

    it('fails the task by name on a loop_back before the round is entered', async () => {
      await deactivate();
      const id = await seedTask(leg);
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      await loopBack(id, source);
      await refusedBefore(id);
      expect((await eventsOf(id)).map((e) => e.eventType)).toContain('step.loop_back');
    });

    it('fails the task by name at the round-limit Continue', async () => {
      await deactivate();
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
      await resolveFixLoopGate(db, await ctxFor(leg, id), gateRow, 'continue', 1, '');
      const t = await taskOf(id);
      expect(t.status).toBe('failed');
      expect(t.errorMessage).toContain(`fix loop target ${customTarget}`);
      const types = (await eventsOf(id)).map((e) => e.eventType);
      expect(types).toContain('fix_loop.unroutable');
      expect(types).not.toContain('fix_loop.continued');
      expect(h.adds).toEqual([]);
    });

    it('does not spend the round cap on a refused round', async () => {
      await deactivate();
      const id = await seedTask(leg, { maxFixRounds: 1 });
      const source = await seedRow(leg, id, 'REVIEW', 0, 'done');
      await loopBack(id, source);
      await refusedBefore(id);
      await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'cfr-fix'));
      await db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      await loopBack(id, source);
      expect(await eventsOf(id, 'fix_loop.started')).toHaveLength(1);
      expect((await taskOf(id)).currentStepId).toBe(customTarget);
    });
  });

  describe('a live task with no run list snapshot that pins a fix target', () => {
    const TYPE = 'cfr_paths_type';
    const CURRENT = 'cfr-p-current';
    const PLAIN = 'module.cfp-plain.target';
    const GHOST = 'module.cfp-ghost.target';
    const OK = 'module.cfp-ok.target';
    const legPin = (stepId: string): Leg => ({
      name: 'paths',
      type: TYPE,
      ids: { TARGET: stepId, REVIEW: CURRENT, AFTER: CURRENT },
      pin: { version: 1, guardedSpans: [], fixTarget: { stepId, capabilityVersion: 1 } },
    });
    const deps: DeadTaskBootDeps = {
      enqueueStart: async () => undefined,
      enqueueAdvance: enqueueRedrive,
      redriveRetryDelaysMs: [],
    };
    const seedPaths = async (pin: object | null, current: string) => {
      const leg = legPin(PLAIN);
      const id = await seedTask(leg, {
        type: TYPE,
        currentStepId: current,
        runListSnapshot: null,
        executionContract: pin,
      });
      await seedRow({ ...leg, ids: { ...leg.ids, REVIEW: current } }, id, 'REVIEW', 0, 'pending');
      return id;
    };

    beforeAll(async () => {
      await db.insert(schema.taskTypeDefinitions).values({
        slug: TYPE,
        displayName: TYPE,
        source: 'test',
        runListStrategy: 'workflow_paths',
      });
      stub(CURRENT, 0, TYPE);
      stub(PLAIN, 1, TYPE);
      stub(OK, 2, TYPE, { fixConsumer: { version: 1 }, editsCodeOrTests: true });
    });
    afterAll(async () => {
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
      await db.delete(schema.taskTypeDefinitions).where(eq(schema.taskTypeDefinitions.slug, TYPE));
    });

    it('is marked dead when the pinned target is registered without the capability', async () => {
      const id = await seedPaths(legPin(PLAIN).pin, CURRENT);
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 1, failed: 0 });
      const t = await taskOf(id);
      expect(t.deadAt).not.toBeNull();
      expect(t.deadReason).toContain(PLAIN);
    });

    it('is marked dead by name when the pinned target is unregistered, and revived once it is registered', async () => {
      const id = await seedPaths(legPin(GHOST).pin, CURRENT);
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 1, failed: 0 });
      expect((await taskOf(id)).deadAt).not.toBeNull();
      const [dead] = await eventsOf(id, 'task.dead');
      expect((dead!.payload as { unresolved?: string[] }).unresolved).toContain(GHOST);
      expect(h.adds).toEqual([]);
      stub(GHOST, 3, TYPE, { fixConsumer: { version: 1 }, editsCodeOrTests: true });
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 0, revived: 1 });
      expect((await taskOf(id)).deadAt).toBeNull();
    });

    it('is left alone when the pinned target is registered and capable', async () => {
      const id = await seedPaths(legPin(OK).pin, CURRENT);
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 0, revived: 0 });
      expect((await taskOf(id)).deadAt).toBeNull();
    });

    it('does not judge a task with no pin whose current step is unregistered', async () => {
      const id = await seedPaths(null, 'cfr-p-unregistered');
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 0, revived: 0 });
      expect((await taskOf(id)).deadAt).toBeNull();
    });

    it('leaves a task whose contract carries no pin and no span alone when its current step is registered', async () => {
      const id = await seedPaths({ version: 1, guardedSpans: [] }, CURRENT);
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 0, revived: 0 });
      expect((await taskOf(id)).deadAt).toBeNull();
    });

    it('keeps judging a static pinned task as before', async () => {
      const custom = LEGS[1]!;
      const id = await seedTask(custom);
      await seedRow(custom, id, 'REVIEW', 0, 'pending');
      expect(await reconcileDeadTasks(db, deps)).toMatchObject({ marked: 0, revived: 0 });
      expect((await taskOf(id)).deadAt).toBeNull();
    });
  });
});
