import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepContext, StepDefinition } from '../src/step-engine/step-definition.js';
import {
  continuationForOutcome,
  activeInsightContinuation,
} from '../src/step-engine/steps/workflow/_insight-continuation.js';
import type { InsightBatchRecord } from '../src/step-engine/steps/workflow/_insight-batch.js';
import { resolveTaskStep } from '../src/queues/run-list.js';
import {
  assertInsightRunList,
  assertInsightTaskSteps,
} from '../src/queues/insight-continuation.js';
import { validateComposition, evaluateDerivedTaskType } from '@haive/shared/modularity';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { keepForPath } from '../src/orchestrator/execution-paths.js';
import { insightGate3ReviewRequired } from '../src/queues/insight-gate3-return.js';
const route = {
  version: 1,
  kind: 'insight_revise',
  batchId: 'batch',
  sourceStepRow: 'source',
  generation: 2,
  round: 3,
} as const;

it('holds the regenerated gate across later check rounds until a gate3 pass settles it', async () => {
  const approval = { version: 1, batchId: 'batch', kind: 'gate2_approved', round: 2 };
  const latest = vi.fn().mockResolvedValue({ payload: approval });
  const settled = vi.fn().mockResolvedValue(undefined);
  const db = {
    query: { taskEvents: { findFirst: latest }, taskSteps: { findFirst: settled } },
  } as unknown as Database;
  const row = {
    taskId: 'task',
    round: 4,
  } as typeof import('@haive/database').schema.taskSteps.$inferSelect;
  expect(await insightGate3ReviewRequired(db, row)).toBe(true);
  settled.mockResolvedValue({ status: 'done' });
  expect(await insightGate3ReviewRequired(db, row)).toBe(false);
  latest.mockResolvedValue(undefined);
  expect(await insightGate3ReviewRequired(db, row)).toBe(false);
  latest.mockResolvedValue({ payload: { ...approval, round: undefined } });
  await expect(insightGate3ReviewRequired(db, row)).rejects.toThrow(/approval round/);
});
const outcome = (result: string) =>
  ({
    version: 1,
    stage: 'outcome',
    batchId: 'batch',
    sourceStepRowId: 'source',
    generation: 2,
    selected: [{ id: 'one' }],
    items: [{ id: 'one', outcome: result, changes: ['change'] }],
  }) as InsightBatchRecord;
const database = (
  options: { generation?: number; checkpoint?: string; version?: number; events?: boolean } = {},
) =>
  ({
    select: () => ({ from: () => ({ where: async () => [{ auto: false }] }) }),
    query: {
      taskEvents: {
        findMany: vi
          .fn()
          .mockResolvedValue(
            options.events === false
              ? []
              : [{ payload: { continuation: { ...route, version: options.version ?? 1 } } }],
          ),
      },
      taskSteps: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ rerunGeneration: options.generation ?? 2 })
          .mockResolvedValue({ status: options.checkpoint ?? 'pending' }),
      },
    },
  }) as unknown as Database;
describe('insight continuation identity and reachability', () => {
  it('only an applied stored outcome creates a continuation', () => {
    expect(continuationForOutcome(outcome('applied'), 2)).toEqual(route);
    for (const result of ['already_handled', 'not_applied', 'unconfirmed'])
      expect(continuationForOutcome(outcome(result), 2)).toBeUndefined();
    expect(continuationForOutcome({ ...outcome('applied'), selected: [] }, 2)).toBeUndefined();
    expect(continuationForOutcome({ ...outcome('applied'), stage: 'intent' }, 2)).toBeUndefined();
  });
  it('skips gate3 checks only for a wholly declined batch with host proof of unchanged files', () => {
    const declined = {
      ...outcome('not_applied'),
      mode: 'gate3' as const,
      worktreeUnchanged: true,
      items: [{ id: 'one', outcome: 'not_applied' as const, changes: [], reason: '' }],
    };
    expect(continuationForOutcome(declined, 2)).toBeUndefined();
    expect(continuationForOutcome({ ...declined, worktreeUnchanged: false }, 2)).toMatchObject({
      mode: 'gate3',
      stage: 'checks',
    });
    expect(continuationForOutcome({ ...declined, worktreeUnchanged: undefined }, 2)).toBeDefined();
    expect(
      continuationForOutcome(
        {
          ...declined,
          items: [
            ...declined.items,
            { id: 'two', outcome: 'applied', changes: ['edit'], reason: '' },
          ],
        },
        2,
      ),
    ).toBeDefined();
    for (const result of ['already_handled', 'unconfirmed'] as const)
      expect(
        continuationForOutcome(
          { ...declined, items: [{ ...declined.items[0]!, outcome: result }] },
          2,
        ),
      ).toBeDefined();
  });
  it('refuses unknown event versions explicitly', async () => {
    await expect(activeInsightContinuation(database({ version: 2 }), 'task', 3)).rejects.toThrow(
      /Unsupported insight continuation/,
    );
  });
  it('source Retry invalidates the older continuation', async () => {
    expect(await activeInsightContinuation(database({ generation: 3 }), 'task', 3)).toBeNull();
  });
  it.each(['pending', 'running', 'waiting_form', 'failed'])(
    'downstream Retry/Resume keeps the route while checkpoint is %s',
    async (checkpoint) => {
      expect(await activeInsightContinuation(database({ checkpoint }), 'task', 4)).toEqual(route);
    },
  );
  it.each(['done', 'skipped'])('settles at a %s checkpoint', async (checkpoint) => {
    expect(await activeInsightContinuation(database({ checkpoint }), 'task', 3)).toBeNull();
  });
  it('does not activate a future route in an older round', async () => {
    expect(await activeInsightContinuation(database(), 'task', 2)).toBeNull();
  });
  it.each(['quick_bugfix', 'plan_tasklist'] as const)(
    '%s retains normal execution while conditionally adding the missing tail',
    async (executionPath) => {
      for (const id of ['08c-code-review', '08e-insights-triage']) {
        expect(keepForPath(id, executionPath)).toBe(true);
        const original = vi.fn().mockResolvedValue(true);
        const def = { metadata: { id }, shouldRun: original } as unknown as StepDefinition;
        const step = resolveTaskStep({ executionPath, runListStrategy: 'workflow_paths' }, id, {
          get: () => def,
        })!;
        const conditional = id === '08e-insights-triage' || executionPath === 'quick_bugfix';
        const ctx = {
          db: database({ events: false }),
          taskId: 'task',
          round: 3,
          throwIfCancelled() {},
        } as StepContext;
        expect(await step.shouldRun!(ctx)).toBe(!conditional);
        expect(original).toHaveBeenCalledTimes(conditional ? 0 : 1);
        original.mockClear();
        expect(await step.shouldRun!({ ...ctx, db: database() })).toBe(true);
        expect(original).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each([
    { runListStrategy: 'workflow_paths', runListSnapshot: ['08c-code-review'] },
    { runListStrategy: 'static', runListSnapshot: null },
    { runListStrategy: 'derived', runListSnapshot: ['08c-code-review'] },
  ] as const)('keeps explicitly listed quick reviews active (%j)', async (scope) => {
    const original = vi.fn().mockResolvedValue(true);
    const def = {
      metadata: { id: '08c-code-review' },
      shouldRun: original,
    } as unknown as StepDefinition;
    const step = resolveTaskStep(
      {
        ...scope,
        runListSnapshot: scope.runListSnapshot ? [...scope.runListSnapshot] : null,
        executionPath: 'quick_bugfix',
      },
      '08c-code-review',
      { get: () => def },
    )!;
    expect(
      await step.shouldRun!({
        db: database({ events: false }),
        throwIfCancelled() {},
      } as StepContext),
    ).toBe(true);
    expect(original).toHaveBeenCalledOnce();
  });
  it('preflights the complete verify/review/checkpoint path', () => {
    const steps = ['08-phase-5-verify', '08c-code-review', '08e-insights-triage'].map((id) => ({
      metadata: { id },
    })) as StepDefinition[];
    expect(() => assertInsightRunList(steps)).not.toThrow();
    for (let index = 0; index < steps.length; index++)
      expect(() => assertInsightRunList(steps.filter((_, i) => i !== index))).toThrow(/run list/);
    expect(() => assertInsightRunList([steps[1]!, steps[0]!, steps[2]!])).toThrow(/run list/);
  });
});

import { insightsTriageStep } from '../src/step-engine/steps/workflow/08e-insights-triage.js';
it('the manual checkpoint has no second selection or editor, even with an old preset', async () => {
  const detected = {
    worktreePath: '/repo',
    sandboxWorktreePath: '/ws',
    spec: '',
    insights: [],
    insightCheckpoint: route,
  };
  const form = await insightsTriageStep.form!({} as never, detected, null);
  expect(form).toMatchObject({ fields: [], autoSubmit: true });
  const args = { detected, formValues: { selectedInsights: ['old-selection'] }, llmOutput: null };
  expect(await insightsTriageStep.agentMining!.selectAgents({ ...args, ctx: {} as never })).toEqual(
    [],
  );
  const output = await insightsTriageStep.apply({ throwIfCancelled() {} } as never, args as never);
  expect(output).toMatchObject({ selected: [], implemented: false });
  expect(insightsTriageStep.reviseLoop!.evaluate(output)).toBeNull();
});

it('enters the durable checkpoint before loading a new inventory or building an editor prompt', async () => {
  const ctx = {
    db: database(),
    taskId: 'task',
    round: 3,
    workspacePath: '/repo',
    sandboxWorkdir: '/ws',
    throwIfCancelled() {},
  } as StepContext;
  expect(await insightsTriageStep.shouldRun!(ctx)).toBe(true);
  const detected = await insightsTriageStep.detect!({ ...ctx, db: database() });
  expect(detected).toMatchObject({ insightCheckpoint: route, insights: [] });
});

describe('insight composition destination order', () => {
  const catalog = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e]));
  const head = ['01-worktree-setup', '07-phase-2-implement'];
  const verify = '08-phase-5-verify';
  const review = '08c-code-review';
  const triage = '08e-insights-triage';
  const reversed = [...head, review, verify, triage];
  const ordered = [...head, verify, review, triage];

  it('rejects the review-before-verify composition that runtime preflight refuses', () => {
    const steps = reversed.map((id) => ({ metadata: { id } })) as StepDefinition[];
    expect(() => assertInsightRunList(steps)).toThrow(/run list/);
    expect(validateComposition(reversed, catalog)).toContainEqual(
      expect.objectContaining({
        kind: 'need-out-of-order',
        stepId: triage,
        needs: 'review',
        after: 'verification',
      }),
    );
  });

  it('accepts verification before review and checkpoint, as runtime preflight does', () => {
    expect(validateComposition(ordered, catalog)).toEqual([]);
    expect(() =>
      assertInsightRunList(ordered.map((id) => ({ metadata: { id } })) as StepDefinition[]),
    ).not.toThrow();
  });

  it('keeps review before verification valid without insight triage', () => {
    expect(validateComposition([...head, review, verify], catalog)).toEqual([]);
  });

  it('rejects the same order in a derived candidate and accepts the ordered candidate', () => {
    const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
    const evaluate = (stepIds: string[]) =>
      evaluateDerivedTaskType({
        baseCandidates: [{ executionPath: null, stepIds: [...prefix, ...stepIds] }],
        changes: [],
        catalog,
        installedStepIds: new Set(catalog.keys()),
      });
    expect(evaluate(reversed).candidates[0]!.compositionIssues).toContainEqual(
      expect.objectContaining({ kind: 'need-out-of-order', stepId: triage }),
    );
    expect(evaluate(ordered).issues).toEqual([]);
    expect(evaluate([...head, review, verify]).issues).toEqual([]);
  });
});

it('quick paths retain a dormant gate2 which becomes active only for a durable approval latch', async () => {
  const id = '09-gate-2-verify-approval';
  expect(keepForPath(id, 'quick_bugfix')).toBe(true);
  const step = resolveTaskStep(
    { executionPath: 'quick_bugfix', runListStrategy: 'workflow_paths' },
    id,
    { get: () => ({ metadata: { id } }) as StepDefinition },
  )!;
  for (const failed of [false, true]) {
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: async () =>
        failed ? [{ payload: { version: 1, kind: 'verify_failed', batchId: 'batch' } }] : [],
    };
    expect(
      await step.shouldRun!({ db: { select: () => chain }, throwIfCancelled() {} } as never),
    ).toBe(failed);
  }
});

it('stored admin/module/derived gate3 compositions without 08e remain valid', () => {
  const ids = [
    '01-worktree-setup',
    '07-phase-2-implement',
    '08-phase-5-verify',
    '09-gate-2-verify-approval',
    '10-gate-3-commit',
  ];
  const catalog = new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e]));
  expect(validateComposition(ids, catalog)).toEqual([]);
  const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
  expect(
    evaluateDerivedTaskType({
      baseCandidates: [{ executionPath: 'quick_bugfix', stepIds: [...prefix, ...ids] }],
      changes: [],
      catalog,
      installedStepIds: new Set(catalog.keys()),
    }).issues,
  ).toEqual([]);
});

it('gate3 pick preflight requires gate2 before any editor or reset, while ordinary 08e keeps its contract', () => {
  const ctx = {} as import('../src/queues/run-list.js').ResolvedTaskContext;
  const ids = [
    '08-phase-5-verify',
    '08c-code-review',
    '08e-insights-triage',
    '09-gate-2-verify-approval',
    '10-gate-3-commit',
  ];
  const steps = ids.map((id) => ({ metadata: { id } })) as StepDefinition[];
  expect(() => assertInsightTaskSteps(ctx, steps, true)).not.toThrow();
  const missing = steps.filter((s) => s.metadata.id !== '09-gate-2-verify-approval');
  expect(() => assertInsightTaskSteps(ctx, missing, true)).toThrow(/gate.?2.*run list/i);
  expect(() => assertInsightTaskSteps(ctx, missing)).not.toThrow();
  const afterGate = [...missing, steps[3]!];
  expect(() => assertInsightTaskSteps(ctx, afterGate, true)).toThrow(/run list/);
});
