import { beforeAll, describe, expect, it } from 'vitest';
import { EXECUTION_PATHS } from '@haive/shared';
import {
  taskRunListIds,
  workflowBaseCandidates,
  catalogWorkflowBaseCandidates,
  baseCandidateParityIssues,
} from '@haive/shared/run-list';
import { evaluateDerivedTaskType } from '@haive/shared/modularity';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';

describe('derived workflow registry/catalog parity', () => {
  beforeAll(() => registerStepsOnce());
  it('matches taskRunListIds on the real registry for null and every path including the prelude', () => {
    const source = (type: string) =>
      stepRegistry.listByWorkflow(type).map((step) => step.metadata.id);
    const expected = [null, ...EXECUTION_PATHS].map((executionPath) => ({
      executionPath,
      stepIds: taskRunListIds(
        {
          workflowType: 'workflow',
          runListStrategy: 'workflow_paths',
          runListSnapshot: null,
          executionPath,
        },
        source,
      ),
    }));
    const rows = stepRegistry
      .all()
      .map(({ metadata }) => ({
        stepId: metadata.id,
        workflowType: metadata.workflowType,
        stepIndex: metadata.index,
      }))
      .reverse();
    expect(workflowBaseCandidates(source)).toEqual(expected);
    const fromCatalog = catalogWorkflowBaseCandidates(rows);
    expect(baseCandidateParityIssues(expected, fromCatalog)).toEqual([]);
    const result = evaluateDerivedTaskType({
      baseCandidates: fromCatalog,
      changes: [],
      catalog: new Map(CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e])),
      installedStepIds: new Set(stepRegistry.all().map((s) => s.metadata.id)),
    });
    expect(result.issues).toEqual([]);
    expect(
      result.candidates.map(({ executionPath, stepIds }) => ({ executionPath, stepIds })),
    ).toEqual(expected);
    for (const candidate of result.candidates) {
      expect(candidate.stepIds.slice(3, 7)).toEqual(source('env_replicate'));
      expect(candidate.compositionIssues).toEqual([]);
    }
  });
  it.each([
    { remove: '08c-code-review' },
    { insertAfter: '08c-code-review', step: 'custom.example.note' },
  ])('new quick overlays can address the conditional review (%j)', (change) => {
    const result = evaluateDerivedTaskType({
      baseCandidates: workflowBaseCandidates((type) =>
        stepRegistry.listByWorkflow(type).map((s) => s.metadata.id),
      ),
      changes: [change],
      catalog: new Map([
        ...CORE_COMPOSABLE_STEPS.map((e) => [e.stepId, e] as const),
        [
          'custom.example.note',
          {
            stepId: 'custom.example.note',
            label: 'Note',
            group: 'check',
            dispatchesCli: false,
            requires: [],
            provides: [],
          },
        ],
      ]),
      installedStepIds: new Set([
        ...stepRegistry.all().map((s) => s.metadata.id),
        'custom.example.note',
      ]),
    });
    const quick = result.candidates.find((c) => c.executionPath === 'quick_bugfix')!;
    expect(quick.outcomes[0]).toMatchObject({ outcome: 'applied' });
    expect(quick.stepIds).toContain('08e-insights-triage');
    if ('remove' in change) {
      expect(quick.stepIds).not.toContain('08c-code-review');
      expect(quick.compositionIssues).toContainEqual(
        expect.objectContaining({
          kind: 'unmet-need',
          stepId: '08e-insights-triage',
          needs: 'review',
        }),
      );
    } else {
      expect(quick.compositionIssues).toEqual([]);
      expect(quick.stepIds).toContain('08c-code-review');
    }
  });

  it('preserves the whole pre-continuation quick and plan base lists', () => {
    const expected = {
      quick_bugfix: [
        '00-model-health-workflow',
        '00a-sync-base',
        '00-triage',
        '01-declare-deps',
        '02-generate-dockerfile',
        '03-build-image',
        '04-verify-environment',
        '00b-estimate',
        '01-worktree-setup',
        '01-debug-mode',
        '01b-install-plugins',
        '01d-browser-access',
        '01a-app-boot',
        '01c-ddev-env',
        '01c1-restore-database',
        '01g-rag-source-selection',
        '02-pre-rag-sync',
        '06a-db-migrate',
        '07-phase-2-implement',
        '07c-ddev-reconcile',
        '07b-phase-4-validate',
        '08b-test-management',
        '08-phase-5-verify',
        '10-gate-3-commit',
        '11b1-rag-source-selection',
        '11a-gate-4-push',
        '11g-save-database',
        '12-worktree-cleanup',
        '13-pr-wait',
      ],
      plan_tasklist: [
        '00-model-health-workflow',
        '00a-sync-base',
        '00-triage',
        '01-declare-deps',
        '02-generate-dockerfile',
        '03-build-image',
        '04-verify-environment',
        '00b-estimate',
        '01-worktree-setup',
        '01-debug-mode',
        '01b-install-plugins',
        '01d-browser-access',
        '01a-app-boot',
        '01c-ddev-env',
        '01c1-restore-database',
        '01e-external-kb-sync',
        '01f-external-plan-sync',
        '01g-rag-source-selection',
        '02-pre-rag-sync',
        '03-phase-0a-discovery',
        '04-phase-0b-pre-planning',
        '04a-spec-audit',
        '05-phase-0b5-spec-quality',
        '05a-resolve-spec-warnings',
        '06-gate-1-spec-approval',
        '06-run-config',
        '06a-db-migrate',
        '06b-sprint-planning',
        '06c-dag-execute',
        '07-phase-2-implement',
        '07c-ddev-reconcile',
        '07b-phase-4-validate',
        '08b-test-management',
        '08-phase-5-verify',
        '08c-code-review',
        '08c2-code-audit',
        '09-gate-2-verify-approval',
        '10-gate-3-commit',
        '11-phase-8-learning',
        '11b-kb-commit',
        '11b1-rag-source-selection',
        '11c-rag-reindex',
        '11e-prompt-guidance',
        '11f-plan-reconcile',
        '11a-gate-4-push',
        '11g-save-database',
        '12-worktree-cleanup',
        '13-pr-wait',
      ],
    } as const;
    const source = (type: string) => stepRegistry.listByWorkflow(type).map((s) => s.metadata.id);
    for (const executionPath of ['quick_bugfix', 'plan_tasklist'] as const) {
      expect(
        workflowBaseCandidates(source, { includeConditionalInsightSteps: false }).find(
          (c) => c.executionPath === executionPath,
        )!.stepIds,
      ).toEqual(expected[executionPath]);
      const live = taskRunListIds(
        {
          workflowType: 'workflow',
          runListStrategy: 'workflow_paths',
          runListSnapshot: null,
          executionPath,
        },
        source,
      );
      expect(
        workflowBaseCandidates(source).find((c) => c.executionPath === executionPath)!.stepIds,
      ).toEqual(live);
      expect(
        live.filter(
          (id) =>
            !(
              id === '08e-insights-triage' ||
              (executionPath === 'quick_bugfix' &&
                (id === '08c-code-review' || id === '09-gate-2-verify-approval'))
            ),
        ),
      ).toEqual(expected[executionPath]);
    }
  });
});

import { isConditionalInsightStep, resolveTaskStep } from '../src/queues/run-list.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
it('new derived quick candidates keep the added tail dormant, while old pins and explicit overlays retain their behavior', async () => {
  registerStepsOnce();
  const base = workflowBaseCandidates((type) =>
    stepRegistry.listByWorkflow(type).map((s) => s.metadata.id),
  );
  const plan = {
    version: 1,
    base: {
      slug: 'workflow',
      runListStrategy: 'workflow_paths',
      candidates: base,
      catalogFingerprint: 'control',
    },
    overlay: { revision: 'control', changes: [] },
    requiresRepository: true,
    composableEntries: CORE_COMPOSABLE_STEPS,
    candidates: base.map((c) => ({ ...c, outcomes: [], compositionIssues: [] })),
    commonPrefix: ['00-model-health-workflow', '00a-sync-base', '00-triage'],
    warnings: [],
  };
  const quick = base.find((c) => c.executionPath === 'quick_bugfix')!.stepIds;
  const scope = {
    runListStrategy: 'derived' as const,
    derivedRunPlan: plan,
    executionPath: 'quick_bugfix' as const,
    runListSnapshot: [...quick],
  };
  for (const id of ['08c-code-review', '08e-insights-triage']) {
    expect(isConditionalInsightStep(scope, id)).toBe(true);
    const step = resolveTaskStep(scope, id, {
      get: () => ({ metadata: { id }, shouldRun: async () => true }) as unknown as StepDefinition,
    })!;
    expect(
      await step.shouldRun!({
        db: { query: { taskEvents: { findMany: async () => [] } } },
        throwIfCancelled() {},
      } as never),
    ).toBe(false);
  }
  const inserted = {
    ...plan,
    overlay: {
      revision: 'insert',
      changes: [{ insertAfter: '08c-code-review', step: '08e-insights-triage' }],
    },
  };
  // A malformed pin is refused rather than treated as a dormant workflow.
  expect(() =>
    isConditionalInsightStep({ ...scope, derivedRunPlan: inserted }, '08e-insights-triage'),
  ).toThrow();
  const legacyBase = workflowBaseCandidates(
    (type) => stepRegistry.listByWorkflow(type).map((s) => s.metadata.id),
    { includeConditionalInsightSteps: false },
  );
  const legacy = {
    ...plan,
    base: { ...plan.base, candidates: legacyBase },
    candidates: legacyBase.map((c) => ({ ...c, outcomes: [], compositionIssues: [] })),
    composableEntries: CORE_COMPOSABLE_STEPS.map((e) => {
      if (e.stepId !== '10-gate-3-commit') return e;
      const { loopTargetStepId: _target, loopBeforeClose: _before, ...old } = e;
      return old;
    }),
  };
  expect(isConditionalInsightStep({ ...scope, derivedRunPlan: legacy }, '08c-code-review')).toBe(
    false,
  );
});
