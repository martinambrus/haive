import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { schema } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import { guardResetRows } from '@haive/shared/modularity';
import {
  GuardDecisionError,
  evaluateGuardDecision,
  guardContractHash,
  validateGuardBounds,
} from '../src/step-engine/guard-decisions.js';
import {
  planGuardSkip,
  advanceGuardSpan,
  skipGuardSpan,
  isRetryableGuardError,
} from '../src/step-engine/guard-span-skip.js';

type Row = typeof schema.taskSteps.$inferSelect;
const ids = ['plan', 'a', 'b', 'report'];
function fixture() {
  const taskId = randomUUID();
  const contract = {
    version: 1 as const,
    guardedSpans: [
      { id: 'work', firstStepId: 'a', lastStepId: 'b', predicateId: 'module.fx.guard', args: {} },
    ],
  };
  const rows = ids.map(
    (stepId, stepIndex) =>
      ({
        id: randomUUID(),
        taskId,
        stepId,
        stepIndex,
        runSeq: stepIndex,
        round: 0,
        rerunGeneration: 0,
        guardState: null,
        status: 'pending',
        iterations: [],
        iterationCount: 0,
      }) as unknown as Row,
  );
  const decision = {
    version: 1 as const,
    taskId,
    round: 0,
    spanId: 'work',
    generation: 0,
    contractHash: guardContractHash(ids, contract),
    boundary: null,
    predicate: null,
    required: null,
    run: false,
  };
  rows[1]!.guardState = decision;
  return { rows, decision, ids, span: contract.guardedSpans[0]! };
}
describe('owned guard skip plan', () => {
  it('selects precisely the pinned members and returns their successor', () => {
    const f = fixture();
    expect(planGuardSkip(f, f.rows)).toMatchObject({
      nextStepId: 'report',
      pending: [f.rows[1], f.rows[2]],
    });
  });
  it.each([
    'running',
    'waiting_cli',
    'waiting_form',
    'done',
    'failed',
    'foreign-skip',
    'missing',
    'output',
    'summary',
    'detectOutput',
    'formValues',
    'applyReceipt',
    'mergeResolveState',
    'startedAt',
    'endedAt',
    'iterations',
    'iterationCount',
    'guardState',
  ])('refuses a member that is not pristine or owned: %s', (change) => {
    const f = fixture();
    const member = f.rows[2]!;
    if (change === 'missing') f.rows.splice(2, 1);
    else if (['running', 'waiting_cli', 'waiting_form', 'done', 'failed'].includes(change))
      member.status = change as Row['status'];
    else if (change === 'foreign-skip') member.status = 'skipped';
    else
      Object.assign(member, {
        [change]: change === 'iterations' ? [{}] : change === 'iterationCount' ? 1 : {},
      });
    expect(() => planGuardSkip(f, f.rows)).toThrow('member-not-pristine');
  });
  it('rejects run:true and never mutates input rows', () => {
    const f = fixture();
    const before = structuredClone(f.rows);
    f.decision.run = true;
    expect(() => planGuardSkip(f, f.rows)).toThrow('span-not-suppressed');
    f.decision.run = false;
    planGuardSkip(f, f.rows);
    expect(f.rows).toEqual(before);
  });
  it('replays a partial owned skip and refuses a stale member generation', () => {
    const f = fixture();
    const first = planGuardSkip(f, f.rows);
    Object.assign(f.rows[2]!, { status: 'skipped', guardState: first.receipt(f.rows[2]!) });
    expect(planGuardSkip(f, f.rows).pending).toEqual([f.rows[1]]);
    f.rows[2]!.rerunGeneration++;
    expect(() => planGuardSkip(f, f.rows)).toThrow('member-not-pristine');
  });
  it.each([
    'version',
    'kind',
    'taskId',
    'round',
    'spanId',
    'entryRowId',
    'entryGeneration',
    'contractHash',
    'generation',
    'extra',
  ])('refuses a tampered member receipt: %s', (field) => {
    const f = fixture();
    const member = f.rows[2]!;
    const receipt = planGuardSkip(f, f.rows).receipt(member);
    member.status = 'skipped';
    member.guardState = { ...receipt, [field]: 'tampered' };
    expect(() => planGuardSkip(f, f.rows)).toThrow('member-not-pristine');
  });
});
it.each([0, -1, 1.1, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
  'refuses invalid bound %s',
  (ms) => {
    for (const key of ['statementTimeoutMs', 'lockTimeoutMs', 'predicateTimeoutMs'])
      expect(() => validateGuardBounds({ [key]: ms })).toThrow('invalid-deadline');
  },
);
it('accepts the largest common Node/Postgres bound', () => {
  expect(validateGuardBounds({ predicateTimeoutMs: 2_147_483_647 }).predicateTimeoutMs).toBe(
    2_147_483_647,
  );
});
it.each([new GuardDecisionError('x'), { code: '55P03' }, { code: '57014' }])(
  'the dormant caller retries protocol/SQL timeouts',
  (err) => {
    expect(isRetryableGuardError(err)).toBe(true);
  },
);
it.each([null, {}, new Error('55P03'), { code: '23505' }])(
  'does not classify other errors as retryable',
  (err) => {
    expect(isRetryableGuardError(err)).toBe(false);
  },
);
it('the dormant advance caller handles raw lock batch timeouts without handing off', async () => {
  const db = {
    query: {
      tasks: {
        findFirst: async () => {
          throw { code: '55P03' };
        },
      },
    },
  };
  const handoff = vi.fn();
  expect(
    await advanceGuardSpan({ db } as unknown as StepContext, 'work', new Map(), handoff),
  ).toEqual({ kind: 'retry' });
  expect(handoff).not.toHaveBeenCalled();
});
describe('explicit reset versus recovery', () => {
  it('includes pending decisions and their downstream skip receipts after an upstream Retry', () => {
    const f = fixture();
    f.rows[2]!.guardState = { kind: 'guard-skip' };
    f.rows[2]!.status = 'skipped';
    expect(guardResetRows(f.rows, [f.rows[0]!], false).map((r) => r.stepId)).toEqual([
      'plan',
      'a',
      'b',
    ]);
    expect(guardResetRows(f.rows, [f.rows[3]!], false).map((r) => r.stepId)).toEqual(['report']);
  });
  it('preserves guards across recovery and isolates other rounds', () => {
    const f = fixture();
    f.rows[2]!.guardState = { kind: 'guard-skip' };
    f.rows[2]!.status = 'skipped';
    const other = { ...f.rows[1]!, id: randomUUID(), round: 1 };
    expect(guardResetRows([...f.rows, other], [f.rows[0]!], false)).not.toContain(other);
    expect(guardResetRows(f.rows, [f.rows[0]!, f.rows[2]!], true)).toEqual([f.rows[0]]);
  });
  it('ordinary rows retain the exact reset set', () => {
    const f = fixture();
    f.rows[1]!.guardState = null;
    expect(guardResetRows(f.rows, [f.rows[0]!], false)).toEqual([f.rows[0]]);
  });
});

it.each([null, { version: 1, guardedSpans: [] }])(
  'ordinary/inert advance and skip are byte-identical no-ops: %j',
  async (executionContract) => {
    const transaction = vi.fn();
    const task = { executionContract };
    const db = { query: { tasks: { findFirst: async () => task } }, transaction };
    const ctx = { db, taskId: 't' } as unknown as StepContext;
    const handoff = vi.fn();
    expect(await advanceGuardSpan(ctx, 'unused', new Map(), handoff)).toEqual({ kind: 'ordinary' });
    expect(await skipGuardSpan(ctx, 'unused', new Map())).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    expect(task).toEqual({ executionContract });
  },
);

it.each(['statementTimeoutMs', 'lockTimeoutMs', 'predicateTimeoutMs'] as const)(
  'both SQL services refuse an overflowing %s before a transaction',
  async (key) => {
    const executionContract = {
      version: 1,
      guardedSpans: [
        { id: 'work', firstStepId: 'a', lastStepId: 'b', predicateId: 'module.fx.guard', args: {} },
      ],
    };
    const transaction = vi.fn();
    const db = {
      query: { tasks: { findFirst: async () => ({ executionContract }) } },
      transaction,
    };
    const ctx = {
      db,
      taskId: 't',
      epoch: 0,
      rerunGeneration: 0,
      throwIfCancelled() {},
    } as unknown as StepContext;
    for (const run of [evaluateGuardDecision, skipGuardSpan])
      await expect(run(ctx, 'work', new Map(), { [key]: 2_147_483_648 })).rejects.toThrow(
        'invalid-deadline',
      );
    expect(transaction).not.toHaveBeenCalled();
  },
);
