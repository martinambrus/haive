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
import { reconcileOrphanedSteps } from '../src/queues/task-queue.js';
import { redriveStalledTasks } from '../src/queues/stalled-redrive.js';
import { reviveDeadTask } from '../src/queues/dead-task-boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';

// Only the existing API/worker capability refusal is bypassed in this file to
// exercise generic recovery/reset below the still-closed production fence.
vi.mock('@haive/shared/modularity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/modularity')>()),
  assertExecutionContractSupported: () => {},
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
});
