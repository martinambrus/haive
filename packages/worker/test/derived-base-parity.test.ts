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
      ).filter(
        (id) =>
          !(
            (id === '08c-code-review' && executionPath === 'quick_bugfix') ||
            (id === '08e-insights-triage' &&
              (executionPath === 'quick_bugfix' || executionPath === 'plan_tasklist'))
          ),
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
  ])('keeps quick overlays path-absent for the historically absent review (%j)', (change) => {
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
    expect(quick.compositionIssues).toEqual([]);
    expect(quick.outcomes[0]).toMatchObject({ outcome: 'path-absent' });
    expect(quick.stepIds).not.toContain('08c-code-review');
    expect(quick.stepIds).not.toContain('08e-insights-triage');
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
        workflowBaseCandidates(source).find((c) => c.executionPath === executionPath)!.stepIds,
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
        live.filter(
          (id) =>
            !(
              id === '08e-insights-triage' ||
              (executionPath === 'quick_bugfix' && id === '08c-code-review')
            ),
        ),
      ).toEqual(expected[executionPath]);
    }
  });
});
