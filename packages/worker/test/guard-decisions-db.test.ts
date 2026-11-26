import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { TaskCancelledError, type StepContext, type StepDefinition } from '@haive/shared/step';
import { z } from 'zod';
import { evaluateGuardDecision } from '../src/step-engine/guard-decisions.js';
import { skipGuardSpan } from '../src/step-engine/guard-span-skip.js';
import {
  FIX_LOOP_REQUESTED,
  isFixRound,
  recordFixLoopRequest,
} from '../src/step-engine/steps/workflow/_fix-loop.js';

const url = process.env.GUARD_DECISIONS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_decisions_test'))
  throw new Error('Use a dedicated guard_decisions_test database');
const predicateId = 'module.fx.planned';
const span = (id: string, step: string) => ({
  id,
  firstStepId: step,
  lastStepId: step,
  predicateId,
  args: { producer: 'plan' },
});
const contract = {
  version: 1,
  guardedSpans: [span('work', 'work'), { ...span('cleanup', 'cleanup'), when: false }],
};
const ids = ['plan', 'work', 'tail', 'cleanup', 'report'];
type Predicate = NonNullable<StepDefinition['guardPredicates']>[string];

describe.skipIf(!url)('durable guard decisions on Postgres', () => {
  let db: Database;
  let userId: string;
  let taskId: string;
  let rows: Record<string, typeof schema.taskSteps.$inferSelect>;
  let ctx: StepContext;
  let evaluate: ReturnType<typeof vi.fn<Predicate['evaluate']>>;
  let predicates: Map<string, Predicate>;
  beforeAll(async () => {
    db = createDatabase(url!);
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: randomBytes(24).toString('hex'),
        emailBlindIndex: randomBytes(32).toString('hex'),
        passwordHash: randomBytes(32).toString('hex'),
      })
      .returning();
    userId = user!.id;
  });
  afterAll(async () => {
    if (db) {
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db.$client.end({ timeout: 5 });
    }
  });
  beforeEach(async () => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'guard-test',
        title: 'Guard test',
        status: 'running',
        runListSnapshot: ids,
        executionContract: contract,
        currentStepId: 'work',
        currentRound: 0,
      })
      .returning();
    taskId = task!.id;
    rows = Object.fromEntries(
      (
        await db
          .insert(schema.taskSteps)
          .values(
            ids.map((stepId, stepIndex) => ({
              taskId,
              stepId,
              stepIndex,
              title: stepId,
              status:
                stepId === 'plan' || stepId === 'tail' ? ('done' as const) : ('pending' as const),
            })),
          )
          .returning()
      ).map((r) => [r.stepId, r]),
    );
    ctx = {
      taskId,
      taskStepId: rows.work!.id,
      userId,
      db,
      repoPath: '/unused',
      workspacePath: '/unused',
      sandboxWorkdir: '/unused',
      cliProviderId: null,
      round: 0,
      epoch: 0,
      rerunGeneration: 0,
      logger: logger.child({ module: 'guard-test' }),
      signal: new AbortController().signal,
      throwIfCancelled() {},
      emitProgress: async () => {},
    } as StepContext;
    evaluate = vi.fn(async () => true);
    predicates = new Map([
      [predicateId, { argsSchema: z.strictObject({ producer: z.literal('plan') }), evaluate }],
    ]);
  });
  const row = (id: string) =>
    db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, rows[id]!.id) });
  async function snapshot() {
    return {
      task: await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }),
      steps: await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .orderBy(schema.taskSteps.id),
      events: await db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId)),
    };
  }
  it('evaluates on the exact settled producer and changes only guard_state', async () => {
    const before = await snapshot();
    const decision = await evaluateGuardDecision(ctx, 'work', predicates);
    expect(decision).toMatchObject({
      version: 1,
      taskId,
      round: 0,
      spanId: 'work',
      generation: 0,
      run: true,
      boundary: { stepRowId: rows.plan!.id, stepId: 'plan', round: 0, generation: 0 },
      predicate: { id: predicateId, result: true },
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]![0]).toMatchObject({
      taskId,
      taskStepId: rows.plan!.id,
      round: 0,
      rerunGeneration: 0,
    });
    expect(evaluate.mock.calls[0]![1]).toEqual({ producer: 'plan' });
    const after = await snapshot();
    before.steps.find((r) => r.id === rows.work!.id)!.guardState = decision;
    expect(after).toEqual(before);
  });
  it.each([true, false])(
    'persists a generation-bound round-one copy (%s) and replays without evaluating',
    async (run) => {
      evaluate.mockResolvedValue(run);
      await db
        .update(schema.tasks)
        .set({
          runListSnapshot: ['module.fx.repair', ...ids],
          executionContract: {
            ...contract,
            fixTarget: { stepId: 'module.fx.repair', capabilityVersion: 1 },
          },
        })
        .where(eq(schema.tasks.id, taskId));
      const original = await evaluateGuardDecision(ctx, 'work', predicates);
      const [current] = await db
        .insert(schema.taskSteps)
        .values({
          taskId,
          stepId: 'work',
          title: 'work',
          stepIndex: 1,
          round: 1,
          rerunGeneration: 4,
          status: 'pending',
        })
        .returning();
      await db.update(schema.tasks).set({ currentRound: 1 }).where(eq(schema.tasks.id, taskId));
      await db.insert(schema.taskEvents).values({
        taskId,
        eventType: FIX_LOOP_REQUESTED,
        payload: { round: 1 },
      });
      const next = { ...ctx, round: 1, taskStepId: current!.id, rerunGeneration: 4 };
      evaluate.mockRejectedValue(new Error('must not evaluate against the changed tree'));
      const [decision, duplicate] = await Promise.all([
        evaluateGuardDecision(next, 'work', predicates),
        evaluateGuardDecision(next, 'work', predicates),
      ]);
      expect(decision).toEqual({ ...original, round: 1, generation: 4 });
      expect(duplicate).toEqual(decision);
      expect(await evaluateGuardDecision(next, 'work', predicates)).toEqual(decision);
      expect((await row('work'))!.guardState).toEqual(original);
      expect(
        (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, current!.id) }))!
          .guardState,
      ).toEqual(decision);
      expect(evaluate).toHaveBeenCalledOnce();
      if (!run) {
        expect(await skipGuardSpan(next, 'work', predicates)).toEqual({ nextStepId: 'tail' });
        expect(await skipGuardSpan(next, 'work', predicates)).toEqual({ nextStepId: 'tail' });
        expect(
          (await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, current!.id) }))!
            .status,
        ).toBe('skipped');
        expect(evaluate).toHaveBeenCalledOnce();
      }
    },
  );
  async function pinFixTarget(requiresSpan = false) {
    await db
      .update(schema.tasks)
      .set({
        runListSnapshot: ['module.fx.repair', ...ids],
        executionContract: {
          ...contract,
          guardedSpans: requiresSpan
            ? [contract.guardedSpans[0]!, { ...contract.guardedSpans[1]!, requiresSpan: 'work' }]
            : contract.guardedSpans,
          fixTarget: { stepId: 'module.fx.repair', capabilityVersion: 1 },
        },
      })
      .where(eq(schema.tasks.id, taskId));
  }
  async function enterRound(round: number, fix: boolean, stepId = 'work') {
    const [current] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId,
        title: stepId,
        stepIndex: ids.indexOf(stepId),
        round,
        rerunGeneration: round + 2,
        status: 'pending',
      })
      .returning();
    await db
      .update(schema.tasks)
      .set({ currentRound: round, currentStepId: stepId })
      .where(eq(schema.tasks.id, taskId));
    if (fix)
      await db.insert(schema.taskEvents).values({
        taskId,
        eventType: FIX_LOOP_REQUESTED,
        payload: { round },
      });
    return { ...ctx, round, taskStepId: current!.id, rerunGeneration: current!.rerunGeneration };
  }
  it.each(['stamped', 'legacy'])(
    'ignores a previous START request on a revise round and keeps that revise as the fix baseline (%s)',
    async (kind) => {
      await pinFixTarget();
      await db.insert(schema.taskEvents).values({ taskId, eventType: 'task.running' });
      if (kind === 'stamped')
        await recordFixLoopRequest(db, taskId, rows.plan!.id, {
          round: 1,
          sourceStepId: 'check',
          diagnosis: 'Old generation defect',
        });
      else
        await db
          .insert(schema.taskEvents)
          .values({ taskId, eventType: FIX_LOOP_REQUESTED, payload: { round: 1 } });
      expect(await isFixRound({ ...ctx, round: 1 })).toBe(true);
      await db.insert(schema.taskEvents).values({ taskId, eventType: 'task.running' });
      await evaluateGuardDecision(ctx, 'work', predicates);
      const revise = await enterRound(1, false);
      expect(await isFixRound(revise)).toBe(false);
      evaluate.mockResolvedValue(false);
      const baseline = await evaluateGuardDecision(revise, 'work', predicates);
      expect(baseline!.run).toBe(false);
      expect(evaluate).toHaveBeenCalledTimes(2);
      const fix = await enterRound(2, false);
      await recordFixLoopRequest(db, taskId, rows.plan!.id, {
        round: 2,
        sourceStepId: 'check',
        diagnosis: '',
      });
      expect(await isFixRound(fix)).toBe(true);
      evaluate.mockRejectedValue(new Error('fix must reuse current START revise'));
      expect(await evaluateGuardDecision(fix, 'work', predicates)).toEqual({
        ...baseline,
        round: 2,
        generation: 4,
      });
      expect(evaluate).toHaveBeenCalledTimes(2);
      await db
        .update(schema.tasks)
        .set({ orchestrationEpoch: 1 })
        .where(eq(schema.tasks.id, taskId));
      expect(await isFixRound({ ...fix, epoch: 1 })).toBe(true);
      expect(await evaluateGuardDecision({ ...fix, epoch: 1 }, 'work', predicates)).toEqual({
        ...baseline,
        round: 2,
        generation: 4,
      });
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
  );
  it('reuses the revise decision when spec-gate revise preceded the first span entry', async () => {
    await pinFixTarget();
    const revise = await enterRound(1, false);
    const original = await evaluateGuardDecision(revise, 'work', predicates);
    const fix = await enterRound(2, true);
    evaluate.mockRejectedValue(new Error('fix must reuse the revise decision'));
    const decision = await evaluateGuardDecision(fix, 'work', predicates);
    expect(decision).toEqual({ ...original, round: 2, generation: 4 });
    expect(await evaluateGuardDecision(fix, 'work', predicates)).toEqual(decision);
    expect(evaluate).toHaveBeenCalledOnce();
    expect((await row('work'))!.guardState).toBeNull();
  });
  it.each([true, false])(
    'reuses the latest revise decision instead of round zero (%s)',
    async (initial) => {
      await pinFixTarget();
      evaluate.mockResolvedValue(initial);
      await evaluateGuardDecision(ctx, 'work', predicates);
      const revise = await enterRound(1, false);
      evaluate.mockResolvedValue(!initial);
      const original = await evaluateGuardDecision(revise, 'work', predicates);
      const fix = await enterRound(2, true);
      evaluate.mockRejectedValue(new Error('fix must reuse the revise decision'));
      const decision = await evaluateGuardDecision(fix, 'work', predicates);
      expect(decision).toEqual({ ...original, round: 2, generation: 4 });
      expect(decision!.run).toBe(!initial);
      expect(await evaluateGuardDecision(fix, 'work', predicates)).toEqual(decision);
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
  );
  it('consecutive fix rounds skip fix receipts and both reuse round zero', async () => {
    await pinFixTarget();
    const original = await evaluateGuardDecision(ctx, 'work', predicates);
    for (const round of [1, 2]) {
      const fix = await enterRound(round, true);
      expect(await evaluateGuardDecision(fix, 'work', predicates)).toEqual({
        ...original,
        round,
        generation: round + 2,
      });
    }
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('skips earlier non-fix rounds that hold no decision for the span', async () => {
    await pinFixTarget();
    const revise = await enterRound(1, false);
    const original = await evaluateGuardDecision(revise, 'work', predicates);
    await enterRound(2, false);
    const fix = await enterRound(3, true);
    expect(await evaluateGuardDecision(fix, 'work', predicates)).toEqual({
      ...original,
      round: 3,
      generation: 5,
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('fails closed by name when no earlier non-fix round holds a decision', async () => {
    await pinFixTarget();
    await enterRound(1, false);
    const fix = await enterRound(2, true);
    await expect(evaluateGuardDecision(fix, 'work', predicates)).rejects.toMatchObject({
      name: 'GuardDecisionError',
      code: 'guard-decision-invalid',
      reason: 'fix-round-decision-unavailable',
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    'requiresSpan and shared reads use the latest non-fix decisions (%s)',
    async (run) => {
      await pinFixTarget(true);
      evaluate.mockResolvedValue(run);
      const work = await enterRound(1, false);
      const parent = await evaluateGuardDecision(work, 'work', predicates);
      const cleanup = await enterRound(1, false, 'cleanup');
      const original = await evaluateGuardDecision(cleanup, 'cleanup', predicates);
      const fix = await enterRound(2, true, 'cleanup');
      evaluate.mockRejectedValue(new Error('shared reads must reuse the revise decisions'));
      const decision = await evaluateGuardDecision(fix, 'cleanup', predicates);
      expect(decision).toEqual({ ...original, round: 2, generation: 4 });
      expect(decision!.required).toMatchObject({ stepRowId: work.taskStepId, generation: 3 });
      expect(decision!.predicate).toEqual(run ? parent!.predicate : null);
      expect(await evaluateGuardDecision(fix, 'cleanup', predicates)).toEqual(decision);
      expect(evaluate).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ['requiresSpan', true],
    ['requiresSpan', false],
    ['shared predicate', true],
    ['shared predicate', false],
  ] as const)(
    'reuses the dependent baseline after revise reaches only its dependency: %s (%s)',
    async (kind, run) => {
      await pinFixTarget(kind === 'requiresSpan');
      if (kind === 'requiresSpan') {
        // Separate predicate ids isolate required references from shared-result references.
        const cleanupPredicate = 'module.fx.cleanup';
        predicates.set(cleanupPredicate, { ...predicates.get(predicateId)!, evaluate });
        await db
          .update(schema.tasks)
          .set({
            executionContract: {
              ...contract,
              guardedSpans: [
                contract.guardedSpans[0]!,
                {
                  ...contract.guardedSpans[1]!,
                  predicateId: cleanupPredicate,
                  requiresSpan: 'work',
                },
              ],
              fixTarget: { stepId: 'module.fx.repair', capabilityVersion: 1 },
            },
          })
          .where(eq(schema.tasks.id, taskId));
      }
      evaluate.mockResolvedValue(run);
      const parent = await evaluateGuardDecision(ctx, 'work', predicates);
      await db
        .update(schema.tasks)
        .set({ currentStepId: 'cleanup' })
        .where(eq(schema.tasks.id, taskId));
      const original = await evaluateGuardDecision(
        { ...ctx, taskStepId: rows.cleanup!.id },
        'cleanup',
        predicates,
      );
      const baselineCalls = evaluate.mock.calls.length;
      const revise = await enterRound(1, false);
      evaluate.mockResolvedValue(!run);
      expect(await evaluateGuardDecision(revise, 'work', predicates)).toMatchObject({ run: !run });
      // Revise fails between A and B, leaving no B decision in round one.
      await db.insert(schema.taskSteps).values({
        taskId,
        stepId: 'tail',
        title: 'tail',
        stepIndex: 2,
        round: 1,
        status: 'failed',
      });
      const fix = await enterRound(2, true, 'cleanup');
      evaluate.mockRejectedValue(new Error('fix must reuse the named round-zero dependency'));
      const decision = await evaluateGuardDecision(fix, 'cleanup', predicates);
      expect(decision).toEqual({ ...original, round: 2, generation: 4 });
      if (kind === 'requiresSpan') {
        expect(decision!.required).toEqual({
          stepRowId: rows.work!.id,
          spanId: 'work',
          generation: 0,
        });
      } else {
        expect(decision!.predicate).toEqual(parent!.predicate);
        expect(decision!.predicate!.source.stepRowId).toBe(rows.work!.id);
      }
      expect(await evaluateGuardDecision(fix, 'cleanup', predicates)).toEqual(decision);
      expect(evaluate).toHaveBeenCalledTimes(baselineCalls + 1);
      expect((await row('work'))!.guardState).toEqual(parent);
      expect((await row('cleanup'))!.guardState).toEqual(original);
    },
  );
  it.each([true, false])(
    'refuses a reset named requiresSpan dependency without writes (%s)',
    async (run) => {
      await pinFixTarget(true);
      evaluate.mockResolvedValue(run);
      await evaluateGuardDecision(ctx, 'work', predicates);
      await db
        .update(schema.tasks)
        .set({ currentStepId: 'cleanup' })
        .where(eq(schema.tasks.id, taskId));
      const baseline = await evaluateGuardDecision(
        { ...ctx, taskStepId: rows.cleanup!.id },
        'cleanup',
        predicates,
      );
      expect(baseline!.required!.stepRowId).toBe(rows.work!.id);
      // Explicit reset invalidates the exact row the dependent's saved decision names.
      await db
        .update(schema.taskSteps)
        .set({ guardState: null, rerunGeneration: 1 })
        .where(eq(schema.taskSteps.id, rows.work!.id));
      const fix = await enterRound(1, true, 'cleanup');
      evaluate.mockClear();
      const before = await snapshot();
      await expect(evaluateGuardDecision(fix, 'cleanup', predicates)).rejects.toMatchObject({
        name: 'GuardDecisionError',
        code: 'guard-decision-invalid',
        reason: 'fix-round-decision-unavailable',
      });
      expect(evaluate).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      await assertLocksReleased();
    },
  );
  it('serializes duplicate advances and replays after an acknowledgement loss or epoch recovery', async () => {
    const decisions = await Promise.all(
      Array.from({ length: 4 }, () => evaluateGuardDecision(ctx, 'work', predicates)),
    );
    expect(decisions.every((d) => JSON.stringify(d) === JSON.stringify(decisions[0]))).toBe(true);
    await db.update(schema.tasks).set({ orchestrationEpoch: 1 }).where(eq(schema.tasks.id, taskId));
    expect(await evaluateGuardDecision({ ...ctx, epoch: 1 }, 'work', predicates)).toEqual(
      decisions[0],
    );
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('rethrows TaskCancelledError by identity and rolls back predicate writes', async () => {
    const before = await snapshot();
    const cancelled = new TaskCancelledError();
    evaluate.mockImplementation(async (producer) => {
      await producer.db
        .update(schema.taskSteps)
        .set({ statusMessage: 'must roll back' })
        .where(eq(schema.taskSteps.id, rows.plan!.id));
      throw cancelled;
    });
    await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toBe(cancelled);
    expect(await snapshot()).toEqual(before);
    await assertLocksReleased();
  });
  // These tests exercise real transaction/connection locks, so use small real deadlines.
  const limits = { statementTimeoutMs: 200, lockTimeoutMs: 100, predicateTimeoutMs: 100 };
  async function watchdog<T>(run: Promise<T>): Promise<T | 'watchdog'> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        run,
        new Promise<'watchdog'>((resolve) => {
          timer = setTimeout(() => resolve('watchdog'), 800);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  async function assertLocksReleased() {
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId))
        .for('no key update', { noWait: true });
      await tx
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .for('update', { noWait: true });
    });
  }
  it('bounds a stalled predicate, rolls back and releases every task lock', async () => {
    const before = await snapshot();
    const release = Promise.withResolvers<boolean>();
    let producerSignal: AbortSignal | undefined;
    const lateWrite = Promise.withResolvers<unknown>();
    evaluate.mockImplementation(async (producer) => {
      producerSignal = producer.signal;
      await producer.db
        .update(schema.taskSteps)
        .set({ statusMessage: 'must roll back' })
        .where(eq(schema.taskSteps.id, rows.plan!.id));
      await release.promise;
      try {
        await producer.db
          .update(schema.taskSteps)
          .set({ statusMessage: 'late write refused' })
          .where(eq(schema.taskSteps.id, rows.plan!.id));
        lateWrite.resolve('unexpected success');
      } catch (err) {
        lateWrite.resolve(err);
      }
      return true;
    });
    const run = evaluateGuardDecision(ctx, 'work', predicates, limits).catch(
      (error: unknown) => error,
    );
    try {
      const failure = await watchdog(run);
      expect(failure).toMatchObject({
        message: 'guard-decision-invalid: predicate-evaluation-failed',
      });
      expect(producerSignal!.aborted).toBe(true);
      await assertLocksReleased();
      expect(await snapshot()).toEqual(before);
    } finally {
      release.resolve(true);
      await run;
    }
    expect(await lateWrite.promise).toSatisfy((err) => hasPgCode(err, 'UNSAFE_TRANSACTION'));
    expect(await snapshot()).toEqual(before);
  });
  it('sets statement_timeout before any predicate SQL and rolls back a cancelled query', async () => {
    const before = await snapshot();
    evaluate.mockImplementation(async (producer) => {
      await producer.db
        .update(schema.taskSteps)
        .set({ statusMessage: 'must roll back' })
        .where(eq(schema.taskSteps.id, rows.plan!.id));
      await producer.db.execute(sql`SELECT pg_sleep(1)`);
      return true;
    });
    const failure = await evaluateGuardDecision(ctx, 'work', predicates, {
      ...limits,
      statementTimeoutMs: 50,
      predicateTimeoutMs: 500,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: 'guard-decision-invalid: predicate-evaluation-failed',
    });
    expect(hasPgCode((failure as Error).cause, '57014')).toBe(true);
    await assertLocksReleased();
    expect(await snapshot()).toEqual(before);
  });
  it('bounds the initial step-lock batch before evaluating a predicate', async () => {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.id, rows.work!.id))
        .for('update');
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const run = evaluateGuardDecision(ctx, 'work', predicates, limits).catch(
      (error: unknown) => error,
    );
    try {
      const failure = await watchdog(run);
      expect(hasPgCode(failure, '55P03')).toBe(true);
      expect(evaluate).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await holder;
      await run;
    }
    await assertLocksReleased();
    expect((await row('work'))!.guardState).toBeNull();
  });
  it.each(['before-write', 'after-write', 'commit'])(
    'rolls back a persistence crash at %s, then commits once on replay',
    async (cut) => {
      await db.execute(
        sql`CREATE OR REPLACE FUNCTION guard_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'guard test crash'; END $$`,
      );
      if (cut === 'commit')
        await db.execute(
          sql`CREATE CONSTRAINT TRIGGER guard_test_cut AFTER UPDATE ON task_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_test_fail()`,
        );
      else if (cut === 'after-write')
        await db.execute(
          sql`CREATE TRIGGER guard_test_cut AFTER UPDATE OF guard_state ON task_steps FOR EACH ROW EXECUTE FUNCTION guard_test_fail()`,
        );
      else
        await db.execute(
          sql`CREATE TRIGGER guard_test_cut BEFORE UPDATE OF guard_state ON task_steps FOR EACH ROW EXECUTE FUNCTION guard_test_fail()`,
        );
      const before = await snapshot();
      try {
        await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toSatisfy((error) =>
          hasPgCode(error, 'P0001'),
        );
        expect(await snapshot()).toEqual(before);
      } finally {
        await db.execute(sql`DROP TRIGGER guard_test_cut ON task_steps`);
        await db.execute(sql`DROP FUNCTION guard_test_fail()`);
      }
      const saved = await evaluateGuardDecision(ctx, 'work', predicates);
      expect(await evaluateGuardDecision(ctx, 'work', predicates)).toEqual(saved);
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
  );
  it('replays a committed result using a new database client without another evaluation', async () => {
    const saved = await evaluateGuardDecision(ctx, 'work', predicates);
    const fresh = createDatabase(url!);
    try {
      expect(await evaluateGuardDecision({ ...ctx, db: fresh }, 'work', predicates)).toEqual(saved);
    } finally {
      await fresh.$client.end({ timeout: 5 });
    }
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('isolates tasks and rounds while keeping generation distinct from the recovery epoch', async () => {
    const original = await evaluateGuardDecision(ctx, 'work', predicates);
    const [other] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'guard-test', title: 'Other' })
      .returning();
    await db.insert(schema.taskSteps).values([
      {
        taskId: other!.id,
        stepId: 'plan',
        title: 'Foreign',
        stepIndex: 0,
        round: 1,
        status: 'done',
      },
      { taskId, stepId: 'plan', title: 'Future', stepIndex: 0, round: 2, status: 'done' },
    ]);
    const [entry] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: 'work',
        title: 'Work again',
        stepIndex: 1,
        round: 1,
        status: 'pending',
        rerunGeneration: 3,
      })
      .returning();
    await db
      .update(schema.tasks)
      .set({ currentRound: 1, orchestrationEpoch: 8 })
      .where(eq(schema.tasks.id, taskId));
    const next = { ...ctx, taskStepId: entry!.id, round: 1, rerunGeneration: 3, epoch: 8 };
    // Neither another task's settled producer nor our future round can supply this boundary.
    // The existing round-0 predecessor is deliberately made unsettled.
    await db
      .update(schema.taskSteps)
      .set({ status: 'pending' })
      .where(eq(schema.taskSteps.id, rows.plan!.id));
    await expect(evaluateGuardDecision(next, 'work', predicates)).rejects.toThrow(
      'producer-not-settled',
    );
    expect(evaluate).toHaveBeenCalledOnce();
    const [producer] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId: 'plan',
        title: 'Plan again',
        stepIndex: 0,
        round: 1,
        status: 'done',
        rerunGeneration: 2,
      })
      .returning();
    evaluate.mockResolvedValue(false);
    expect(await evaluateGuardDecision(next, 'work', predicates)).toMatchObject({
      round: 1,
      generation: 3,
      run: false,
      boundary: { stepRowId: producer!.id, round: 1, generation: 2 },
    });
    expect((await row('work'))!.guardState).toEqual(original);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
