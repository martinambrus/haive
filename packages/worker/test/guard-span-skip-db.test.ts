import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database, type DbTx } from '@haive/database';
import { configService, logger } from '@haive/shared';
import type { StepContext, StepDefinition } from '@haive/shared/step';
import { z } from 'zod';
import { evaluateGuardDecision } from '../src/step-engine/guard-decisions.js';
import { advanceGuardSpan, skipGuardSpan } from '../src/step-engine/guard-span-skip.js';
import { resetStepAndDownstream, autoResumeFailedStep } from '../src/queues/_step-reset.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { handleResult, reconcileOrphanedSteps } from '../src/queues/task-queue.js';
import { redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import { reviveDeadTask } from '../src/queues/dead-task-boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { holdReopenedForm } from '../src/step-engine/step-runner.js';

// Only the existing API/worker capability refusal is bypassed in this file to
// exercise generic recovery/reset below the still-closed production fence.
vi.mock('@haive/shared/modularity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/modularity')>()),
  assertExecutionContractSupported: () => {},
}));
vi.mock('../src/step-engine/execution-contract-support.js', () => ({
  assertWorkerExecutionContractSupported: () => {},
}));
vi.mock('../../api/src/lib/execution-contract-admission.js', () => ({
  assertExecutionContractUsable: () => {},
}));
vi.mock('../../api/src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => {} }) }));
vi.mock('../../api/src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
// Runtime cross-package test seam; keep the API source out of the worker's tsc root.
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const { Hono } = apiRequire('hono');
const apiStepsPath = new URL('../../api/src/routes/tasks/steps.ts', import.meta.url).pathname;
const apiControlPath = new URL('../../api/src/lib/task-control.ts', import.meta.url).pathname;
const apiErrorPath = new URL('../../api/src/middleware/error-handler.ts', import.meta.url).pathname;
let retryTaskAtStep: (
  db: Database,
  taskId: string,
  userId: string,
  target: Row,
) => Promise<unknown>;
let supersedeLiveRuns: (tx: DbTx, taskId: string, opts: { failTask: boolean }) => Promise<unknown>;
let stepRoutes: unknown;
let errorHandler: unknown;
const state = vi.hoisted(() => ({ db: undefined as unknown, userId: '' }));
vi.mock('../../api/src/db.js', () => ({ getDb: () => state.db }));
vi.mock('../../api/src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', state.userId);
    await next();
  },
}));

vi.mock('../src/redis.js', async (original) => ({
  ...(await original<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {
    async add() {}
  },
}));

const url = process.env.GUARD_SPAN_SKIP_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_span_skip_test'))
  throw new Error('Use a dedicated guard_span_skip_test database');
const ids = ['plan', 'a', 'b', 'report'];
const predicateId = 'module.fx.guard';
const contract = {
  version: 1,
  guardedSpans: [{ id: 'work', firstStepId: 'a', lastStepId: 'b', predicateId, args: {} }],
};
type Row = typeof schema.taskSteps.$inferSelect;
type Predicate = NonNullable<StepDefinition['guardPredicates']>[string];
describe.skipIf(!url)('owned guard spans on Postgres', () => {
  let db: Database, userId: string, taskId: string, rows: Record<string, Row>, ctx: StepContext;
  let evaluate: ReturnType<typeof vi.fn<Predicate['evaluate']>>, predicates: Map<string, Predicate>;
  beforeAll(async () => {
    db = createDatabase(url!);
    state.db = db;
    ({ retryTaskAtStep, stepRoutes } = await import(apiStepsPath));
    ({ supersedeLiveRuns } = await import(apiControlPath));
    ({ errorHandler } = await import(apiErrorPath));
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const [u] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: randomBytes(24).toString('hex'),
        emailBlindIndex: randomBytes(32).toString('hex'),
        passwordHash: randomBytes(32).toString('hex'),
      })
      .returning();
    userId = u!.id;
    state.userId = userId;
    for (const id of ids)
      stepRegistry.register({
        metadata: {
          id,
          workflowType: 'workflow',
          index: ids.indexOf(id),
          title: id,
          description: '',
          requiresCli: false,
        },
        detect: async () => ({}),
        apply: async () => ({}),
      } as StepDefinition);
  });
  afterAll(async () => {
    if (db) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.$client.end({ timeout: 5 });
    }
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    // Each representative owns the only live task considered by global recovery sweeps.
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    const [t] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'guard-test',
        metadata: { anchorRepositoryId: null },
        title: 'Guard span',
        status: 'running',
        runListSnapshot: ids,
        executionContract: contract,
        currentStepId: 'a',
      })
      .returning();
    taskId = t!.id;
    rows = Object.fromEntries(
      (
        await db
          .insert(schema.taskSteps)
          .values(
            ids.map((stepId, stepIndex) => ({
              taskId,
              stepId,
              title: stepId,
              stepIndex,
              runSeq: stepIndex,
              status: stepId === 'plan' ? ('done' as const) : ('pending' as const),
            })),
          )
          .returning()
      ).map((r) => [r.stepId, r]),
    );
    ctx = {
      taskId,
      taskStepId: rows.a!.id,
      userId,
      db,
      round: 0,
      epoch: 0,
      rerunGeneration: 0,
      signal: new AbortController().signal,
      throwIfCancelled() {},
      logger,
    } as unknown as StepContext;
    evaluate = vi.fn(async () => false);
    predicates = new Map([[predicateId, { argsSchema: z.strictObject({}), evaluate }]]);
  });
  const task = () => db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) });
  const read = () =>
    db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId))
      .orderBy(schema.taskSteps.runSeq);
  const decide = () => evaluateGuardDecision(ctx, 'work', predicates);
  const skip = () => skipGuardSpan(ctx, 'work', predicates);
  async function saved() {
    await decide();
    await skip();
    return read();
  }
  it('serializes duplicate skips and fences stale epochs and generations without output, recap or events', async () => {
    await decide();
    const before = await task();
    const results = await Promise.all([skip(), skip(), skip()]);
    expect(results).toEqual(Array(3).fill({ nextStepId: 'report' }));
    const steps = await read();
    expect(steps.map((r) => r.status)).toEqual(['done', 'skipped', 'skipped', 'pending']);
    expect(steps.every((r) => r.output === null && r.summary === null)).toBe(true);
    expect(
      await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId)),
    ).toEqual([]);
    expect(await task()).toEqual(before);
    await expect(skipGuardSpan({ ...ctx, epoch: 1 }, 'work', predicates)).rejects.toThrow(
      'task-fence-lost',
    );
    await expect(skipGuardSpan({ ...ctx, rerunGeneration: 1 }, 'work', predicates)).rejects.toThrow(
      'entry-fence-lost',
    );
    expect(await read()).toEqual(steps);
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('F3 two finished-row redeliveries append one step.skipped event', async () => {
    const skipped = (await saved()).find((r) => r.stepId === 'a')!;
    const loaded = await task();
    const pickup = {
      ...loaded,
      taskId,
      userId,
      orchestrationEpoch: 0,
      runListStrategy: 'static',
    } as unknown as ResolvedTaskContext;
    for (let i = 0; i < 2; i++)
      await handleResult(db, pickup, 'a', { status: 'skipped', row: skipped }, { redrive: true });
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskStepId, skipped.id));
    expect(events.filter((e) => e.eventType === 'step.skipped')).toHaveLength(1);
    expect(skipped.endedAt).toBeInstanceOf(Date);
    expect(skipped.updatedAt).toEqual(skipped.endedAt);
  });
  it('F6 unmaterialized members produce a refusal, not an endless retry', async () => {
    await db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, rows.b!.id));
    const handoff = vi.fn();
    expect(await advanceGuardSpan(ctx, 'work', predicates, handoff)).toEqual({
      kind: 'refused',
      reason: 'missing-member',
    });
    expect(handoff).not.toHaveBeenCalled();
  });
  it('F6 an unsettled predecessor is a refusal, never a retry', async () => {
    await db
      .update(schema.taskSteps)
      .set({ status: 'pending' })
      .where(eq(schema.taskSteps.id, rows.plan!.id));
    const handoff = vi.fn();
    expect(await advanceGuardSpan(ctx, 'work', predicates, handoff)).toEqual({
      kind: 'refused',
      reason: 'producer-not-settled',
    });
    expect(handoff).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('rolls back a partial-skip crash and replays the already committed decision', async () => {
    await decide();
    const before = await read();
    // The second member aborts after the first UPDATE; PostgreSQL rolls both back.
    await db.execute(
      sql`CREATE FUNCTION guard_skip_cut() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.step_id = 'b' AND NEW.status = 'skipped' THEN RAISE EXCEPTION 'skip cut'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER guard_skip_cut BEFORE UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION guard_skip_cut()`,
    );
    try {
      await expect(skip()).rejects.toSatisfy((e) => hasPgCode(e, 'P0001'));
      expect(await read()).toEqual(before);
    } finally {
      await db.execute(sql`DROP TRIGGER guard_skip_cut ON task_steps`);
      await db.execute(sql`DROP FUNCTION guard_skip_cut()`);
    }
    await skip();
    expect((await read()).map((r) => r.status)).toEqual(['done', 'skipped', 'skipped', 'pending']);
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('replays enqueue cuts before delivery and after acknowledgement loss without step work', async () => {
    const delivered: (string | null)[] = [];
    const handoff = vi.fn(async (next: string | null) => {
      if (handoff.mock.calls.length === 1) throw new Error('before enqueue');
      delivered.push(next);
      if (handoff.mock.calls.length === 2) throw new Error('lost acknowledgement');
    });
    await expect(advanceGuardSpan(ctx, 'work', predicates, handoff)).rejects.toThrow(
      'before enqueue',
    );
    const before = await read();
    await expect(advanceGuardSpan(ctx, 'work', predicates, handoff)).rejects.toThrow(
      'lost acknowledgement',
    );
    expect(await advanceGuardSpan(ctx, 'work', predicates, handoff)).toEqual({ kind: 'skipped' });
    expect(delivered).toEqual(['report', 'report']);
    expect(await read()).toEqual(before);
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('invalidates pending decisions as well as owned skips on an upstream worker rerun', async () => {
    await decide();
    const reset = await resetStepAndDownstream(db, taskId, 'plan', 0, 0);
    expect(reset).toMatchObject({ newEpoch: 1 });
    expect((await read()).every((r) => r.guardState === null && r.status === 'pending')).toBe(true);
    expect((await read()).find((r) => r.stepId === 'a')!.rerunGeneration).toBe(1);
  });
  it('refuses a busy run on a guard entry published after the reset read, without partial reset', async () => {
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holding: Promise<unknown> | undefined;
    let invocationId = '';
    const raced = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return async (fn: (tx: DbTx) => Promise<unknown>) => {
          // The worker has read a pristine downstream entry, but has not taken
          // its ordered batch. A legitimate guard/runner wins that interval.
          evaluate.mockResolvedValue(true);
          await decide();
          await db
            .update(schema.taskSteps)
            .set({ status: 'running' })
            .where(eq(schema.taskSteps.id, rows.a!.id));
          const [run] = await db
            .insert(schema.cliInvocations)
            .values({
              taskId,
              taskStepId: rows.a!.id,
              mode: 'cli',
              prompt: 'guard race control',
            })
            .returning();
          invocationId = run!.id;
          holding = db.transaction(async (tx) => {
            await tx
              .select()
              .from(schema.cliInvocations)
              .where(eq(schema.cliInvocations.id, invocationId))
              .for('no key update');
            acquired.resolve();
            await release.promise;
          });
          await acquired.promise;
          return db.transaction(fn);
        };
      },
    });
    try {
      await expect(resetStepAndDownstream(raced, taskId, 'plan', 0, 0)).rejects.toSatisfy((err) =>
        hasPgCode(err, '55P03'),
      );
      expect((await task())!.orchestrationEpoch).toBe(0);
      const after = await read();
      expect(after[0]!.status).toBe('done');
      expect(after[1]).toMatchObject({ status: 'running', rerunGeneration: 0 });
      expect(after[1]!.guardState).not.toBeNull();
    } finally {
      release.resolve();
      await holding;
    }
    await resetStepAndDownstream(db, taskId, 'plan', 0, 0);
    expect((await read())[1]).toMatchObject({
      status: 'pending',
      guardState: null,
      rerunGeneration: 1,
    });
    const run = await db.query.cliInvocations.findFirst({
      where: eq(schema.cliInvocations.id, invocationId),
    });
    expect(run!.supersededAt).not.toBeNull();
  });
  it('task Retry and the step Retry route invalidate dependent skips in the same transaction', async () => {
    await saved();
    await db
      .update(schema.tasks)
      .set({ status: 'failed', currentStepId: 'plan' })
      .where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.taskSteps)
      .set({ status: 'failed' })
      .where(eq(schema.taskSteps.id, rows.plan!.id));
    const target = (await read())[0]!;
    await retryTaskAtStep(db, taskId, userId, target);
    expect((await read()).every((r) => r.guardState === null)).toBe(true);
    // Republish at the new generation, then exercise the actual owner step action.
    await db
      .update(schema.taskSteps)
      .set({ status: 'done' })
      .where(eq(schema.taskSteps.id, rows.plan!.id));
    await db.update(schema.tasks).set({ currentStepId: 'a' }).where(eq(schema.tasks.id, taskId));
    ctx.epoch = 1;
    ctx.rerunGeneration = 1;
    await saved();
    const app = new Hono();
    app.use(
      '*',
      async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
        c.set('userId', userId);
        await next();
      },
    );
    app.route('/', stepRoutes);
    app.onError(errorHandler);
    const response = await app.request(`/${taskId}/steps/plan/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'retry', round: 0 }),
    });
    expect(response.status).toBe(200);
    expect((await read()).every((r) => r.guardState === null && r.status === 'pending')).toBe(true);
  });
  it.each([true, false])(
    'Resume rescans from its retained producer when a run:%s decision commits after the empty cascade read',
    async (run) => {
      await db
        .update(schema.taskSteps)
        .set({ output: { retained: true } })
        .where(eq(schema.taskSteps.id, rows.plan!.id));
      await db.insert(schema.taskStepAgentMinings).values({
        taskStepId: rows.plan!.id,
        agentId: 'retry-me',
        agentTitle: 'Retry me',
        status: 'failed',
      });
      let published = false;
      state.db = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'transaction') return Reflect.get(target, key, receiver);
          return async (fn: (tx: DbTx) => Promise<unknown>) => {
            // The route already read only pristine pending downstream rows.
            // Publish the competing decision before Resume takes its ordered batch.
            if (!published) {
              published = true;
              evaluate.mockResolvedValue(run);
              await decide();
              if (!run) await skip();
            }
            return db.transaction(fn);
          };
        },
      });
      const app = new Hono();
      app.use(
        '*',
        async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
          c.set('userId', userId);
          await next();
        },
      );
      app.route('/', stepRoutes);
      app.onError(errorHandler);
      try {
        const response = await app.request(`/${taskId}/steps/plan/action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'resume', round: 0 }),
        });
        expect(response.status).toBe(200);
        expect(published).toBe(true);
        const after = await read();
        expect(after[0]).toMatchObject({
          status: 'running',
          output: { retained: true },
          rerunGeneration: 0,
        });
        expect(after[1]).toMatchObject({ status: 'pending', guardState: null, rerunGeneration: 1 });
        expect(after[2]).toMatchObject({
          status: 'pending',
          guardState: null,
          rerunGeneration: run ? 0 : 1,
        });
        expect(after[3]!.rerunGeneration).toBe(0);
        expect((await task())!.orchestrationEpoch).toBe(1);
        expect(evaluate).toHaveBeenCalledOnce();
        expect(
          await db
            .select()
            .from(schema.taskStepAgentMinings)
            .where(eq(schema.taskStepAgentMinings.taskStepId, rows.plan!.id)),
        ).toMatchObject([{ status: 'failed', userRetryRequestedAt: expect.any(Date) }]);
      } finally {
        state.db = db;
      }
    },
  );
  it('Stop and provider Resume preserve committed skip identity byte-for-byte', async () => {
    const before = await saved();
    await db
      .update(schema.tasks)
      .set({ currentStepId: 'report' })
      .where(eq(schema.tasks.id, taskId));
    await db.transaction((tx) => supersedeLiveRuns(tx, taskId, { failTask: true }));
    expect((await task())!.status).toBe('failed');
    expect(
      await autoResumeFailedStep(db, {
        taskId,
        stepId: 'report',
        round: 0,
        providerId: null,
        via: 'guard-test',
        watchSince: null,
      }),
    ).toBe(true);
    expect((await read()).slice(1, 3)).toEqual(before.slice(1, 3));
  });
  it('boot recovery preserves decisions/generations and never reopens a skipped span', async () => {
    const before = await saved();
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, rows.plan!.id));
    await db.update(schema.tasks).set({ currentStepId: 'plan' }).where(eq(schema.tasks.id, taskId));
    const enqueueAdvance = vi.fn(async () => {});
    await reconcileOrphanedSteps(db, {
      enqueueAdvance,
      queuedInvocationIds: async () => new Set(),
    });
    expect((await read()).slice(1, 3)).toEqual(before.slice(1, 3));
    expect((await task())!.orchestrationEpoch).toBe(1);
    expect(enqueueAdvance).toHaveBeenCalledOnce();
  });
  it('stalled handoff and dead revival preserve decisions and skipped rows across epoch takeovers', async () => {
    const before = await saved();
    const enqueueAdvance = vi.fn(async () => {});
    await db
      .update(schema.tasks)
      .set({ updatedAt: new Date(0) })
      .where(eq(schema.tasks.id, taskId));
    expect(
      await redriveStalledTasks(
        db,
        {
          enqueueAdvance,
          enqueueStart: async () => {},
          queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
          queuedInvocationIds: async () => new Set(),
          failTask: async () => false,
        },
        { staleMs: 0 },
      ),
    ).toBe(1);
    expect((await read()).slice(1, 3)).toEqual(before.slice(1, 3));
    await db
      .update(schema.tasks)
      .set({ deadAt: new Date(), deadReason: 'test missing executable' })
      .where(eq(schema.tasks.id, taskId));
    const t = (await task())!;
    expect(
      await reviveDeadTask(
        db,
        { ...t, epoch: t.orchestrationEpoch },
        { enqueueAdvance, enqueueStart: async () => {}, redriveRetryDelaysMs: [] },
      ),
    ).toBe('advance');
    expect((await read()).slice(1, 3)).toEqual(before.slice(1, 3));
    ctx.epoch = (await task())!.orchestrationEpoch;
    expect(await skip()).toEqual({ nextStepId: 'report' });
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('ordinary tasks remain byte-identical and take no guard transaction or handoff', async () => {
    await db
      .update(schema.tasks)
      .set({ executionContract: null })
      .where(eq(schema.tasks.id, taskId));
    const before = { task: await task(), steps: await read() };
    const handoff = vi.fn();
    expect(await advanceGuardSpan(ctx, 'work', predicates, handoff)).toEqual({ kind: 'ordinary' });
    expect(await skip()).toBeNull();
    expect(handoff).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect({ task: await task(), steps: await read() }).toEqual(before);
  });
  it('reconciles a held form generation with dependent/shared skips atomically across crash and replay', async () => {
    const expanded = {
      ...contract,
      guardedSpans: [
        ...contract.guardedSpans,
        {
          id: 'closed',
          firstStepId: 'report',
          lastStepId: 'report',
          predicateId,
          args: {},
          requiresSpan: 'work',
          when: false,
        },
      ],
    };
    await db
      .update(schema.tasks)
      .set({ executionContract: expanded })
      .where(eq(schema.tasks.id, taskId));
    evaluate.mockResolvedValue(true);
    await decide();
    for (const id of ['a', 'b'])
      await db
        .update(schema.taskSteps)
        .set({ status: 'done' })
        .where(eq(schema.taskSteps.id, rows[id]!.id));
    await db
      .update(schema.tasks)
      .set({ currentStepId: 'report' })
      .where(eq(schema.tasks.id, taskId));
    const later = { ...ctx, taskStepId: rows.report!.id };
    await evaluateGuardDecision(later, 'closed', predicates);
    await skipGuardSpan(later, 'closed', predicates);
    await db.update(schema.tasks).set({ currentStepId: 'a' }).where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.taskSteps)
      .set({ status: 'running', formValues: { old: true } })
      .where(eq(schema.taskSteps.id, rows.a!.id));
    const [agent] = await db
      .insert(schema.taskStepAgentMinings)
      .values({
        taskStepId: rows.a!.id,
        agentId: 'folded',
        agentTitle: 'Folded',
        status: 'done',
      })
      .returning();
    const folded = [{ agentId: 'folded', invocationId: null }] as unknown as Parameters<
      typeof holdReopenedForm
    >[2];
    const before = await read();
    const at = new Date();
    // Fail the generation write after the guard references have been updated.
    await db.execute(
      sql`CREATE FUNCTION guard_reopen_cut() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.step_id = 'a' AND NEW.rerun_generation > OLD.rerun_generation THEN RAISE EXCEPTION 'reopen cut'; END IF; RETURN NEW; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER guard_reopen_cut BEFORE UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION guard_reopen_cut()`,
    );
    try {
      await expect(holdReopenedForm(db, rows.a!.id, folded, at, 1, ctx)).rejects.toSatisfy((e) =>
        hasPgCode(e, 'P0001'),
      );
      expect(await read()).toEqual(before);
      expect(
        (await db.query.taskStepAgentMinings.findFirst({
          where: eq(schema.taskStepAgentMinings.id, agent!.id),
        }))!.consumedAt,
      ).toBeNull();
    } finally {
      await db.execute(sql`DROP TRIGGER guard_reopen_cut ON task_steps`);
      await db.execute(sql`DROP FUNCTION guard_reopen_cut()`);
    }
    await holdReopenedForm(db, rows.a!.id, folded, at, 1, ctx);
    const after = await read();
    expect(after[1]).toMatchObject({
      rerunGeneration: 1,
      pauseFormOnRetry: true,
      formValues: null,
      guardState: { generation: 1, run: true, predicate: { source: { generation: 1 } } },
    });
    expect(after[3]).toMatchObject({
      status: 'skipped',
      rerunGeneration: 0,
      guardState: {
        generation: 0,
        required: { generation: 1 },
        predicate: { source: { generation: 1 } },
      },
    });
    expect(after[3]!.endedAt).toEqual(before[3]!.endedAt);
    await expect(skipGuardSpan({ ...ctx, rerunGeneration: 1 }, 'work', predicates)).rejects.toThrow(
      'entry-fence-lost',
    );
    expect(await read()).toEqual(after);
    // A lost acknowledgement cannot consume/bump this old pass a second time.
    await expect(holdReopenedForm(db, rows.a!.id, folded, at, 1, ctx)).rejects.toThrow(
      'reset, skipped or stopped',
    );
    expect(await read()).toEqual(after);
    await db
      .update(schema.tasks)
      .set({ currentStepId: 'report' })
      .where(eq(schema.tasks.id, taskId));
    expect(await skipGuardSpan(later, 'closed', predicates)).toEqual({ nextStepId: null });
    expect(evaluate).toHaveBeenCalledOnce();
    await resetStepAndDownstream(db, taskId, 'plan', 0, 0);
    expect((await read())[1]).toMatchObject({
      status: 'pending',
      guardState: null,
      rerunGeneration: 2,
      formSchema: null,
    });
  });
});
