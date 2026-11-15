import type { DerivedRunPlanV1, DerivedRunPlanV2 } from '@haive/shared/modularity';
import { CODE_REVIEW_OUTPUT_CONTRACT } from '@haive/shared/step-outputs';

export const REVIEW = '08c-code-review';
export const AUDIT = '08c2-code-audit';
export const PRODUCER = 'module.example.review';
export function rolePlan(version: 1 | 2 = 1): DerivedRunPlanV1 | DerivedRunPlanV2 {
  const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
  const paths = [null, 'quick_bugfix', 'plan_tasklist', 'full_workflow'] as const;
  const changes = version === 2 ? [{ replace: REVIEW, with: PRODUCER }] : [];
  const baseCandidates = paths.map((executionPath) => ({
    executionPath,
    stepIds: [...prefix, REVIEW, AUDIT],
  }));
  const producer = {
    stepId: PRODUCER,
    label: 'Review',
    group: 'review',
    dispatchesCli: true,
    requires: [],
    provides: ['review'],
    replaces: [REVIEW],
    outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
  };
  return {
    version,
    base: {
      slug: 'workflow',
      runListStrategy: 'workflow_paths',
      candidates: baseCandidates,
      catalogFingerprint: 'frozen',
    },
    overlay: { revision: 'frozen', changes },
    requiresRepository: true,
    commonPrefix: prefix,
    warnings: [],
    composableEntries: [
      producer,
      ...(version === 2
        ? [...prefix, REVIEW, AUDIT].map((stepId) => ({
            stepId,
            label: stepId,
            group: 'test',
            dispatchesCli: false,
            requires: [],
            provides: stepId === REVIEW ? ['review'] : [],
          }))
        : []),
    ],
    candidates: baseCandidates.map((c) => ({
      ...c,
      stepIds: [...prefix, version === 2 ? PRODUCER : REVIEW, AUDIT],
      compositionIssues: [],
      outcomes: changes.map((change, operationIndex) => ({
        change,
        operationIndex,
        outcome: 'applied' as const,
        reason: 'change-applied' as const,
      })),
      ...(version === 2
        ? {
            effectiveEntries: [producer],
            roleBindings: {
              [REVIEW]: { stepId: PRODUCER, outputContract: CODE_REVIEW_OUTPUT_CONTRACT },
            },
          }
        : {}),
    })),
  } as DerivedRunPlanV1 | DerivedRunPlanV2;
}
export function rolePin(version: 1 | 2 = 2) {
  const derivedRunPlan = rolePlan(version);
  return {
    derivedRunPlan,
    executionPath: 'full_workflow' as const,
    runListSnapshot: derivedRunPlan.candidates.find((c) => c.executionPath === 'full_workflow')!
      .stepIds,
  };
}
