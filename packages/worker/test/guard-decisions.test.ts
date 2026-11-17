import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GUARD_DECISION_BOUNDS,
  buildGuardPredicateContext,
  decideLoadedGuardDecision,
  guardContractHash,
  prepareGuardDecision,
  evaluateGuardDecision,
  parseGuardDecision,
} from '../src/step-engine/guard-decisions.js';
import {
  assertExecutionContractSupported,
  ExecutionContractError,
  type ExecutionContract,
} from '@haive/shared/modularity';
import { randomBytes, randomUUID } from 'node:crypto';
import type { schema } from '@haive/database';
import { TaskCancelledError, type StepContext, type StepDefinition } from '@haive/shared/step';
import { z } from 'zod';
import { sql } from 'drizzle-orm';

it('ordinary and inert tasks return without a transaction, predicate or state write', async () => {
  const transaction = vi.fn();
  for (const executionContract of [null, { version: 1, guardedSpans: [] }]) {
    const db = {
      query: { tasks: { findFirst: async () => ({ executionContract }) } },
      transaction,
    };
    expect(
      await evaluateGuardDecision({ db, taskId: 't' } as never, 'unused', new Map()),
    ).toBeNull();
  }
  expect(transaction).not.toHaveBeenCalled();
});

it('refuses malformed durable decisions instead of treating them as false', () => {
  for (const value of [null, {}, { version: 99 }, { version: 1, run: false }])
    expect(() => parseGuardDecision(value)).toThrow('guard-decision-invalid');
});

it('the decision service has no skip or handoff writer and the shared fence refuses a guarded pin outside a static pinned list', () => {
  const executionContract = {
    version: 1,
    guardedSpans: [
      { id: 'x', firstStepId: 'x', lastStepId: 'x', predicateId: 'module.fx.planned', args: {} },
    ],
  };
  let caught: unknown;
  try {
    assertExecutionContractSupported(executionContract, { staticPinnedList: false });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExecutionContractError);
  const source = readFileSync(
    new URL('../src/step-engine/guard-decisions.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/status\s*:\s*['"]skipped['"]|\.insert\(|\.delete\(|\.add\(/);
});

const GUARD_SERVICE_CALLERS = [
  'packages/worker/src/step-engine/guard-decisions.ts',
  'packages/worker/src/step-engine/guard-entry.ts',
  'packages/worker/src/step-engine/guard-reopen.ts',
  'packages/worker/src/step-engine/guard-span-skip.ts',
];
const repoRoot = new URL('../../../', import.meta.url);
function guardServiceReferences(): string[] {
  const found: string[] = [];
  function check(dir: URL): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) check(file);
      else if (
        /evaluateGuardDecision|guard-decisions|skipGuardSpan|advanceGuardSpan|guard-span-skip/.test(
          readFileSync(file, 'utf8'),
        )
      )
        found.push(file.pathname.slice(repoRoot.pathname.length));
    }
  }
  for (const root of [
    new URL('../../', import.meta.url),
    new URL('../../../modules/', import.meta.url),
    new URL('../../../external-modules/', import.meta.url),
  ])
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const source = new URL(`${entry.name}/src/`, root);
      if (entry.isDirectory() && existsSync(source)) check(source);
    }
  return found.sort();
}

it('only the allowlisted production files reference the guard services', () => {
  const unexpected = guardServiceReferences().filter((f) => !GUARD_SERVICE_CALLERS.includes(f));
  expect(unexpected).toEqual([]);
});

it('the worker guard entry exists and is the one caller of advanceGuardSpan', () => {
  const entry = new URL('../src/step-engine/guard-entry.ts', import.meta.url);
  expect(existsSync(entry)).toBe(true);
  expect(readFileSync(entry, 'utf8')).toMatch(/advanceGuardSpan/);
  const callers = guardServiceReferences().filter((f) =>
    readFileSync(new URL(f, repoRoot), 'utf8').includes('advanceGuardSpan'),
  );
  expect(callers).toEqual([
    'packages/worker/src/step-engine/guard-entry.ts',
    'packages/worker/src/step-engine/guard-span-skip.ts',
  ]);
});

it('pins the production SQL, lock and predicate bounds', () => {
  expect(GUARD_DECISION_BOUNDS).toEqual({
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    predicateTimeoutMs: 5_000,
  });
});

type TaskRow = typeof schema.tasks.$inferSelect;
type StepRow = typeof schema.taskSteps.$inferSelect;
type Predicate = NonNullable<StepDefinition['guardPredicates']>[string];
const predicateId = 'module.fx.planned';
const ids = ['plan', 'work', 'tail', 'cleanup', 'report'];
const span = (id: string, step: string) => ({
  id,
  firstStepId: step,
  lastStepId: step,
  predicateId,
  args: { producer: 'plan' },
});
const contract = (): ExecutionContract => ({
  version: 1,
  guardedSpans: [span('work', 'work'), { ...span('cleanup', 'cleanup'), when: false }],
});

// Loaded rows are the seam: no PostgreSQL, SQL builder imitation or real waiting.
describe('guard decisions from loaded rows', () => {
  let task: TaskRow;
  let rows: Record<string, StepRow>;
  let ctx: StepContext;
  let tx: StepContext['db'];
  let evaluate: ReturnType<typeof vi.fn<Predicate['evaluate']>>;
  let predicates: Map<string, Predicate>;
  beforeEach(() => {
    vi.useFakeTimers();
    task = {
      id: randomUUID(),
      userId: randomUUID(),
      status: 'running',
      deadAt: null,
      currentStepId: 'work',
      currentRound: 0,
      orchestrationEpoch: 0,
      runListSnapshot: [...ids],
      executionContract: contract(),
    } as TaskRow;
    rows = Object.fromEntries(
      ids.map((stepId, stepIndex) => [
        stepId,
        {
          id: randomUUID(),
          taskId: task.id,
          stepId,
          stepIndex,
          round: 0,
          rerunGeneration: 0,
          guardState: null,
          status: stepId === 'plan' || stepId === 'tail' ? 'done' : 'pending',
        } as StepRow,
      ]),
    );
    tx = {} as StepContext['db'];
    ctx = {
      taskId: task.id,
      taskStepId: rows.work!.id,
      userId: task.userId,
      round: 0,
      epoch: 0,
      rerunGeneration: 0,
      db: {} as StepContext['db'],
      logger: { warn: vi.fn() },
      signal: new AbortController().signal,
      throwIfCancelled: vi.fn(),
      emitProgress: vi.fn(),
      repoPath: '/unavailable',
      workspacePath: '/unavailable',
      sandboxWorkdir: '/unavailable',
      host: { mustNotLeak: true },
    } as unknown as StepContext;
    evaluate = vi.fn(async () => true);
    predicates = new Map([
      [
        predicateId,
        {
          argsSchema: z.strictObject({ producer: z.literal('plan') }),
          evaluate,
        },
      ],
    ]);
  });
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  async function decide(spanId = 'work') {
    const prepared = prepareGuardDecision(ctx, task, spanId, predicates);
    const result = await decideLoadedGuardDecision(
      ctx,
      prepared,
      Object.values(rows),
      predicates,
      tx,
      GUARD_DECISION_BOUNDS,
    );
    return result.decision;
  }
  async function save(spanId = 'work') {
    const decision = await decide(spanId);
    rows[spanId]!.guardState = structuredClone(decision);
    return decision;
  }
  function at(step: string) {
    task.currentStepId = step;
    ctx.taskStepId = rows[step]!.id;
  }
  const currentContract = () => task.executionContract as ExecutionContract;

  it('evaluates the exact settled producer without changing loaded rows', async () => {
    const before = structuredClone({ task, rows });
    expect(await decide()).toMatchObject({
      version: 1,
      taskId: task.id,
      round: 0,
      spanId: 'work',
      generation: 0,
      run: true,
      boundary: { stepRowId: rows.plan!.id, stepId: 'plan', round: 0, generation: 0 },
      predicate: { id: predicateId, result: true },
      required: null,
      // Ties the decision path to the hash pinned by the fixed vector below.
      contractHash: guardContractHash(ids, currentContract()),
    });
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        taskId: task.id,
        taskStepId: rows.plan!.id,
        round: 0,
        rerunGeneration: 0,
      }),
      { producer: 'plan' },
    );
    expect({ task, rows }).toEqual(before);
  });

  it('hashes the fixed code-unit vector including nested free keys', () => {
    const vector = {
      version: 1 as const,
      guardedSpans: [{ ...span('work', 'work'), args: { a: 2, ä: 3, B: 1 } }],
    };
    expect(guardContractHash(ids, vector)).toBe(
      '653e97ad68f54eb1094d5fa0270c37d564bd36f179bd4f490b936986374fc542',
    );
    const reordered = {
      guardedSpans: [
        {
          args: { B: 1, ä: 3, a: 2 },
          predicateId,
          lastStepId: 'work',
          firstStepId: 'work',
          id: 'work',
        },
      ],
      version: 1 as const,
    };
    expect(guardContractHash(ids, reordered)).toBe(guardContractHash(ids, vector));
    expect(guardContractHash([...ids].reverse(), vector)).not.toBe(guardContractHash(ids, vector));
  });

  it('passes only structural identity, the transaction and cancellation capabilities', async () => {
    await decide();
    const producer = evaluate.mock.calls[0]![0];
    expect(producer.db).toBe(tx);
    expect(producer.db).not.toBe(ctx.db);
    expect(producer.logger).toBe(ctx.logger);
    expect(producer.signal).toBeInstanceOf(AbortSignal);
    expect(producer).not.toHaveProperty('host');
    for (const field of ['repoPath', 'workspacePath', 'sandboxWorkdir'] as const)
      expect(() => producer[field]).toThrow('guard predicate capability unavailable');
    await expect(producer.emitProgress('refuse')).rejects.toThrow(
      'guard predicate capability unavailable',
    );
    expect(ctx.emitProgress).not.toHaveBeenCalled();
    expect(Object.keys(producer).sort()).toEqual(
      [
        'db',
        'logger',
        'round',
        'rerunGeneration',
        'signal',
        'taskId',
        'taskStepId',
        'throwIfCancelled',
        'userId',
      ].sort(),
    );
    expect(producer.signal.aborted).toBe(true);
  });

  it('binds context identity to the producer round and generation', () => {
    rows.plan!.round = 2;
    rows.plan!.rerunGeneration = 3;
    const abort = new AbortController();
    const producer = buildGuardPredicateContext(ctx, tx, task, rows.plan!, abort.signal);
    expect(producer).toMatchObject({ taskStepId: rows.plan!.id, round: 2, rerunGeneration: 3 });
    producer.throwIfCancelled();
    expect(ctx.throwIfCancelled).toHaveBeenCalledOnce();
    const reason = new Error('cancelled');
    abort.abort(reason);
    expect(() => producer.throwIfCancelled()).toThrow(reason);
  });

  it.each(['throw', 'non-boolean', 'write-then-throw'])(
    'refuses predicate errors (%s) rather than recording false',
    async (mode) => {
      const write = vi.fn(async () => []);
      tx = { execute: write } as unknown as StepContext['db'];
      evaluate.mockImplementation(async (producer) => {
        if (mode === 'non-boolean') return null as never;
        if (mode === 'write-then-throw') await producer.db.execute(sql`SELECT 1`);
        throw new Error('untrusted diagnostic');
      });
      await expect(decide()).rejects.toThrow(
        mode === 'non-boolean' ? 'predicate-non-boolean' : 'predicate-evaluation-failed',
      );
      expect(rows.work!.guardState).toBeNull();
      if (mode === 'write-then-throw') expect(write).toHaveBeenCalledOnce();
      evaluate.mockResolvedValue(false);
      expect(await decide()).toMatchObject({ run: false, predicate: { result: false } });
    },
  );

  it('preserves predicate causes and logs the original error', async () => {
    const err = Object.assign(new Error('private predicate text'), {
      params: [randomBytes(24).toString('hex')],
      query: 'select $1',
      cause: Object.assign(new Error('private driver text'), { code: 'XX001' }),
    });
    evaluate.mockRejectedValue(err);
    await expect(decide()).rejects.toMatchObject({
      cause: err,
      message: 'guard-decision-invalid: predicate-evaluation-failed',
    });
    expect(ctx.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { err, taskId: task.id, spanId: 'work' },
      'guard predicate evaluation failed',
    );
    expect(rows.work!.guardState).toBeNull();
  });

  it('rethrows TaskCancelledError by identity', async () => {
    const cancelled = new TaskCancelledError();
    evaluate.mockRejectedValue(cancelled);
    await expect(decide()).rejects.toBe(cancelled);
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it.each(['never-settles', 'emitProgress'])(
    'bounds a %s predicate and ends its signal',
    async (mode) => {
      vi.useFakeTimers();
      let signal: AbortSignal;
      evaluate.mockImplementation(async (producer) => {
        signal = producer.signal;
        if (mode === 'emitProgress') await producer.emitProgress('refuse');
        else await new Promise(() => {});
        return true;
      });
      const failure = expect(decide()).rejects.toThrow('predicate-evaluation-failed');
      await vi.advanceTimersByTimeAsync(GUARD_DECISION_BOUNDS.predicateTimeoutMs);
      await failure;
      expect(signal!.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(rows.work!.guardState).toBeNull();
    },
  );

  it.each(['missing-predicate', 'bad-args', 'malformed-contract', 'no-producer'])(
    'refuses invalid declarations (%s)',
    async (change) => {
      if (change === 'missing-predicate') predicates.clear();
      if (change === 'bad-args')
        for (const s of currentContract().guardedSpans) s.args = { unknown: true };
      if (change === 'malformed-contract') task.executionContract = { version: 99 };
      if (change === 'no-producer') task.runListSnapshot = ids.slice(1);
      await expect(decide()).rejects.toThrow();
      expect(evaluate).not.toHaveBeenCalled();
      expect(rows.work!.guardState).toBeNull();
    },
  );

  it.each(['pending', 'failed', 'skipped', 'missing'])(
    'refuses an unsettled or missing producer (%s)',
    async (status) => {
      if (status === 'missing') delete rows.plan;
      else rows.plan!.status = status as 'pending';
      await expect(decide()).rejects.toThrow('producer-not-settled');
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it.each([
    'failed',
    'cancelled',
    'completed',
    'dead',
    'epoch',
    'owner',
    'pointer',
    'generation',
    'round',
    'task-pointer',
    'entry-status',
    'missing-entry',
  ])('refuses overtaken ownership (%s)', async (change) => {
    if (change === 'dead') task.deadAt = new Date();
    else if (change === 'epoch') ctx.epoch = 1;
    else if (change === 'owner') ctx.userId = randomUUID();
    else if (change === 'pointer') ctx.taskStepId = rows.cleanup!.id;
    else if (change === 'generation') ctx.rerunGeneration = 1;
    else if (change === 'round') task.currentRound = 1;
    else if (change === 'task-pointer') task.currentStepId = 'cleanup';
    else if (change === 'entry-status') rows.work!.status = 'running';
    else if (change === 'missing-entry') delete rows.work;
    else task.status = change as 'failed';
    const before = structuredClone({ task, rows });
    await expect(decide()).rejects.toThrow(
      ['pointer', 'generation', 'task-pointer', 'entry-status', 'missing-entry'].includes(change)
        ? 'entry-fence-lost'
        : 'task-fence-lost',
    );
    expect({ task, rows }).toEqual(before);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    'state',
    'entry-generation',
    'producer-generation',
    'contract',
    'task',
    'round',
    'span',
    'hash',
    'result',
    'source',
    'boundary',
  ])('refuses tampered or stale replay (%s)', async (change) => {
    const saved = await save();
    if (change === 'state') rows.work!.guardState = { version: 9 };
    else if (change === 'entry-generation') {
      rows.work!.rerunGeneration = 1;
      ctx.rerunGeneration = 1;
    } else if (change === 'producer-generation') rows.plan!.rerunGeneration = 1;
    else if (change === 'contract') currentContract().guardedSpans[0]!.when = false;
    else {
      if (change === 'task') saved.taskId = randomUUID();
      if (change === 'round') saved.round = 1;
      if (change === 'span') saved.spanId = 'other';
      if (change === 'hash') saved.contractHash = '0'.repeat(64);
      if (change === 'result') saved.run = false;
      if (change === 'source') saved.predicate!.source.stepRowId = randomUUID();
      if (change === 'boundary') saved.boundary!.stepRowId = randomUUID();
      rows.work!.guardState = saved;
    }
    const reason: Record<string, string> = {
      state: 'malformed-state',
      'producer-generation': 'stale-producer',
      boundary: 'stale-producer',
      result: 'invalid-predicate-decision',
      source: 'stale-predicate-source',
    };
    await expect(decide()).rejects.toThrow(
      `guard-decision-invalid: ${reason[change] ?? 'stale-decision'}`,
    );
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('replays the same decision across a recovery epoch without evaluating again', async () => {
    const saved = await save();
    task.orchestrationEpoch = ctx.epoch = 8;
    expect(await decide()).toEqual(saved);
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    'only replays a skipped entry with run:false (predicate=%s)',
    async (result) => {
      evaluate.mockResolvedValue(result);
      const saved = await save();
      rows.work!.status = 'skipped';
      if (result) await expect(decide()).rejects.toThrow('entry-fence-lost');
      else expect(await decide()).toEqual(saved);
      expect(evaluate).toHaveBeenCalledOnce();
    },
  );

  it('reuses the earliest shared predicate for the opposite branch', async () => {
    const first = await save();
    at('cleanup');
    const second = await decide('cleanup');
    expect(second).toMatchObject({
      run: false,
      predicate: {
        result: true,
        source: { stepRowId: rows.work!.id, spanId: 'work', generation: 0 },
      },
    });
    expect(second.predicate).toEqual(first.predicate);
    expect(second.boundary).toEqual(first.boundary);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('requires an earlier durable shared decision instead of newer producer data', async () => {
    at('cleanup');
    await expect(decide('cleanup')).rejects.toThrow('shared-decision-unavailable');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('suppresses a dependent without evaluating its unrelated predicate and replays it', async () => {
    const otherId = 'module.fx.merged';
    Object.assign(currentContract().guardedSpans[1]!, {
      predicateId: otherId,
      requiresSpan: 'work',
      when: true,
    });
    predicates.set(otherId, {
      argsSchema: z.strictObject({ producer: z.literal('plan') }),
      evaluate,
    });
    evaluate.mockResolvedValue(false);
    await save();
    at('cleanup');
    const saved = await save('cleanup');
    expect(saved).toMatchObject({
      run: false,
      predicate: null,
      boundary: null,
      required: { spanId: 'work', stepRowId: rows.work!.id, generation: 0 },
    });
    expect(await decide('cleanup')).toEqual(saved);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('does not borrow a future-round producer', async () => {
    rows.plan!.round = 1;
    await expect(decide()).rejects.toThrow('producer-not-settled');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('binds structural reads to the intended producer plan through the supplied seam', async () => {
    const findFirst = vi.fn(
      async ({ where }: { where: { taskId: string; taskStepId: string } }) => {
        const plans = [
          { taskId: task.id, taskStepId: rows.plan!.id, planned: false },
          { taskId: task.id, taskStepId: rows.tail!.id, planned: true },
        ];
        return plans.find((p) => p.taskId === where.taskId && p.taskStepId === where.taskStepId);
      },
    );
    tx = { query: { taskDagPlans: { findFirst } } } as unknown as StepContext['db'];
    evaluate.mockImplementation(async (producer) => {
      // The trusted predicate reads through its supplied transaction seam.
      const plan = await (
        producer.db as unknown as { query: { taskDagPlans: { findFirst: typeof findFirst } } }
      ).query.taskDagPlans.findFirst({
        where: { taskId: producer.taskId, taskStepId: producer.taskStepId },
      });
      if (!plan) throw new Error('missing producer plan');
      return plan.planned;
    });
    expect(await decide()).toMatchObject({ run: false });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { taskId: task.id, taskStepId: rows.plan!.id },
    });
  });
});
