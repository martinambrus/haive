import type { StepCatalogRead, inspectDerivedDefinition } from '@haive/shared/modularity-server';
import { CODE_REVIEW_OUTPUT_CONTRACT, STEP_ROLES } from '@haive/shared/step-outputs';
export function replacementAdmissionFixture() {
  const role = STEP_ROLES.codeReview;
  const payload = 'module.acme.check';
  const ids = ['00-model-health-workflow', '00a-sync-base', '00-triage', role];
  const entries = [...ids, payload].map((stepId) => ({
    stepId,
    label: stepId,
    group: 'test',
    dispatchesCli: false,
    requires: [],
    provides: stepId === role || stepId === payload ? ['review'] : [],
    ...(stepId === role || stepId === payload
      ? { outputContract: CODE_REVIEW_OUTPUT_CONTRACT }
      : {}),
    ...(stepId === payload ? { replaces: [role] } : {}),
  }));
  const catalog: StepCatalogRead = {
    synced: true,
    orderedRows: ids.map((stepId, stepIndex) => ({ stepId, stepIndex, workflowType: 'workflow' })),
    stepIds: new Set([...ids, payload]),
    dispatchesCli: new Set(),
    composable: new Map(entries.map((e) => [e.stepId, e])),
    steps: [],
    invalid: [],
  };
  const definition = {
    slug: 'derived-test',
    source: 'admin',
    runListStrategy: 'derived',
    requiresRepository: true,
    baseSlug: 'workflow',
    changes: [{ replace: role, with: payload }],
    promptSteps: {},
    preAnswerDefaults: {},
    stepLoopLimitDefaults: {},
  } satisfies Parameters<typeof inspectDerivedDefinition>[0];
  const base = {
    slug: 'workflow',
    source: 'builtin',
    runListStrategy: 'workflow_paths',
    requiresRepository: true,
  } satisfies NonNullable<Parameters<typeof inspectDerivedDefinition>[1]>;
  return { definition, base, catalog, role, payload };
}
