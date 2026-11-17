import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { StepContext, StepDefinition } from '@haive/shared/step';
import { z } from 'zod';
import { evaluateGuardDecision } from '../src/step-engine/guard-decisions.js';

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
  async function at(step: string) {
    await db.update(schema.tasks).set({ currentStepId: step }).where(eq(schema.tasks.id, taskId));
    return { ...ctx, taskStepId: rows[step]!.id };
  }
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
  it('reuses the earliest shared predicate and applies the opposite branch without re-evaluating', async () => {
    const first = await evaluateGuardDecision(ctx, 'work', predicates);
    const second = await evaluateGuardDecision(await at('cleanup'), 'cleanup', predicates);
    expect(second).toMatchObject({
      spanId: 'cleanup',
      run: false,
      predicate: {
        result: true,
        source: { stepRowId: rows.work!.id, spanId: 'work', generation: 0 },
      },
    });
    expect(first!.predicate!.source).toEqual(second!.predicate!.source);
    expect(evaluate).toHaveBeenCalledOnce();
    expect((await row('cleanup'))!.status).toBe('pending');
  });
  it.each(['throw', 'non-boolean', 'write-then-throw'])(
    'rolls back predicate errors (%s), never recording false',
    async (mode) => {
      const before = await snapshot();
      evaluate.mockImplementation(async (producer) => {
        if (mode === 'non-boolean') return null as never;
        if (mode === 'write-then-throw')
          await producer.db
            .update(schema.taskSteps)
            .set({ statusMessage: 'must roll back' })
            .where(eq(schema.taskSteps.id, rows.plan!.id));
        throw new Error('untrusted diagnostic');
      });
      await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toThrow(
        'predicate-evaluation-failed',
      );
      expect(await snapshot()).toEqual(before);
      evaluate.mockResolvedValue(false);
      expect(await evaluateGuardDecision(ctx, 'work', predicates)).toMatchObject({
        run: false,
        predicate: { result: false },
      });
    },
  );
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
  it.each(['pending', 'failed', 'skipped', 'missing'])(
    'refuses an unsettled or missing producer (%s)',
    async (status) => {
      if (status === 'missing')
        await db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, rows.plan!.id));
      else
        await db
          .update(schema.taskSteps)
          .set({ status: status as 'pending' })
          .where(eq(schema.taskSteps.id, rows.plan!.id));
      await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toThrow(
        'producer-not-settled',
      );
      expect(evaluate).not.toHaveBeenCalled();
      expect((await row('work'))!.guardState).toBeNull();
    },
  );
  it.each(['failed', 'cancelled', 'completed', 'dead', 'epoch', 'owner', 'pointer', 'generation'])(
    'refuses overtaken ownership (%s) without writing',
    async (change) => {
      if (change === 'dead')
        await db
          .update(schema.tasks)
          .set({ deadAt: new Date() })
          .where(eq(schema.tasks.id, taskId));
      else if (change === 'epoch') ctx.epoch = 1;
      else if (change === 'owner') ctx.userId = randomUUID();
      else if (change === 'pointer') ctx.taskStepId = rows.cleanup!.id;
      else if (change === 'generation') ctx.rerunGeneration = 1;
      else
        await db
          .update(schema.tasks)
          .set({ status: change as 'failed' })
          .where(eq(schema.tasks.id, taskId));
      const before = await snapshot();
      await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toThrow(
        'guard-decision',
      );
      expect(await snapshot()).toEqual(before);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it.each(['state', 'entry-generation', 'producer-generation', 'contract'])(
    'refuses tampered or stale replay (%s)',
    async (change) => {
      await evaluateGuardDecision(ctx, 'work', predicates);
      if (change === 'state')
        await db
          .update(schema.taskSteps)
          .set({ guardState: { version: 9 } })
          .where(eq(schema.taskSteps.id, rows.work!.id));
      if (change === 'entry-generation') {
        await db
          .update(schema.taskSteps)
          .set({ rerunGeneration: 1 })
          .where(eq(schema.taskSteps.id, rows.work!.id));
        ctx.rerunGeneration = 1;
      }
      if (change === 'producer-generation')
        await db
          .update(schema.taskSteps)
          .set({ rerunGeneration: 1 })
          .where(eq(schema.taskSteps.id, rows.plan!.id));
      if (change === 'contract')
        await db
          .update(schema.tasks)
          .set({
            executionContract: {
              ...contract,
              guardedSpans: contract.guardedSpans.map((s) => ({ ...s, when: false })),
            },
          })
          .where(eq(schema.tasks.id, taskId));
      await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toThrow(
        'guard-decision',
      );
      expect(evaluate).toHaveBeenCalledOnce();
    },
  );
  it('requires an earlier durable shared decision rather than reading newer producer data', async () => {
    await expect(evaluateGuardDecision(await at('cleanup'), 'cleanup', predicates)).rejects.toThrow(
      'shared-decision-unavailable',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('suppresses a dependent without evaluating its unrelated predicate', async () => {
    const otherId = 'module.fx.merged';
    await db
      .update(schema.tasks)
      .set({
        executionContract: {
          ...contract,
          guardedSpans: [
            contract.guardedSpans[0],
            { ...contract.guardedSpans[1], predicateId: otherId, requiresSpan: 'work', when: true },
          ],
        },
      })
      .where(eq(schema.tasks.id, taskId));
    evaluate.mockResolvedValue(false);
    await evaluateGuardDecision(
      ctx,
      'work',
      (predicates = new Map([
        ...predicates,
        [otherId, { argsSchema: z.strictObject({ producer: z.literal('plan') }), evaluate }],
      ])),
    );
    expect(await evaluateGuardDecision(await at('cleanup'), 'cleanup', predicates)).toMatchObject({
      run: false,
      predicate: null,
      required: { spanId: 'work', stepRowId: rows.work!.id, generation: 0 },
    });
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('does not borrow another task or a future-round producer', async () => {
    await db
      .delete(schema.taskSteps)
      .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, 'plan')));
    await db
      .insert(schema.taskSteps)
      .values({ taskId, stepId: 'plan', title: 'Future', stepIndex: 0, round: 1, status: 'done' });
    await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toThrow(
      'producer-not-settled',
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
  it.each([null, { version: 1, guardedSpans: [] }])(
    'leaves real ordinary task rows unchanged (%j)',
    async (executionContract) => {
      await db.update(schema.tasks).set({ executionContract }).where(eq(schema.tasks.id, taskId));
      const before = await snapshot();
      expect(await evaluateGuardDecision(ctx, 'work', predicates)).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it.each(['missing-predicate', 'bad-args', 'malformed-contract', 'no-producer'])(
    'refuses invalid declarations (%s)',
    async (change) => {
      if (change === 'missing-predicate') predicates.clear();
      if (change === 'bad-args')
        await db
          .update(schema.tasks)
          .set({
            executionContract: {
              ...contract,
              guardedSpans: contract.guardedSpans.map((s) => ({ ...s, args: { unknown: true } })),
            },
          })
          .where(eq(schema.tasks.id, taskId));
      if (change === 'malformed-contract')
        await db
          .update(schema.tasks)
          .set({ executionContract: { version: 99 } })
          .where(eq(schema.tasks.id, taskId));
      if (change === 'no-producer')
        await db
          .update(schema.tasks)
          .set({ runListSnapshot: ids.slice(1) })
          .where(eq(schema.tasks.id, taskId));
      const before = await snapshot();
      await expect(evaluateGuardDecision(ctx, 'work', predicates)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(evaluate).not.toHaveBeenCalled();
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
  it('binds structural reads to the intended plan, not another plan on the same task', async () => {
    await db.insert(schema.taskDagPlans).values([
      { taskId, taskStepId: rows.plan!.id, mode: 'dag', planJson: { planned: false } },
      { taskId, taskStepId: rows.tail!.id, mode: 'dag', planJson: { planned: true } },
    ]);
    evaluate.mockImplementation(async (producer) => {
      const plan = await producer.db.query.taskDagPlans.findFirst({
        where: and(
          eq(schema.taskDagPlans.taskId, producer.taskId),
          eq(schema.taskDagPlans.taskStepId, producer.taskStepId),
        ),
      });
      if (!plan) throw new Error('missing producer plan');
      return (plan.planJson as { planned: boolean }).planned;
    });
    expect(await evaluateGuardDecision(ctx, 'work', predicates)).toMatchObject({ run: false });
  });
  it('keeps round and entry generation distinct from the recovery epoch', async () => {
    const original = await evaluateGuardDecision(ctx, 'work', predicates);
    const [producer, entry] = await db
      .insert(schema.taskSteps)
      .values([
        {
          taskId,
          stepId: 'plan',
          title: 'Plan again',
          stepIndex: 0,
          round: 1,
          status: 'done',
          rerunGeneration: 2,
        },
        {
          taskId,
          stepId: 'work',
          title: 'Work again',
          stepIndex: 1,
          round: 1,
          status: 'pending',
          rerunGeneration: 3,
        },
      ])
      .returning();
    await db
      .update(schema.tasks)
      .set({ currentRound: 1, orchestrationEpoch: 8 })
      .where(eq(schema.tasks.id, taskId));
    evaluate.mockResolvedValue(false);
    expect(
      await evaluateGuardDecision(
        { ...ctx, taskStepId: entry!.id, round: 1, rerunGeneration: 3, epoch: 8 },
        'work',
        predicates,
      ),
    ).toMatchObject({
      round: 1,
      generation: 3,
      run: false,
      boundary: { stepRowId: producer!.id, round: 1, generation: 2 },
    });
    expect((await row('work'))!.guardState).toEqual(original);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
