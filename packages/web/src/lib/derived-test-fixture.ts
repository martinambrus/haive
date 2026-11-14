import type { TaskTypeCatalog } from './api-client';
export function derivedFixture() {
  const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
  const candidates = [
    { executionPath: null, stepIds: [...prefix, 'a', 'b'] },
    { executionPath: 'quick_bugfix' as const, stepIds: [...prefix, 'a'] },
  ];
  const catalog: TaskTypeCatalog = {
    synced: true,
    modules: [],
    groups: [{ id: 'test', label: 'Test' }],
    registeredStepIds: [...prefix, 'a', 'b', 'x', 'y'],
    steps: [...prefix, 'a', 'b', 'x', 'y'].map((stepId) => ({
      stepId,
      source: 'builtin',
      title: stepId,
      entry: {
        stepId,
        label: stepId,
        group: 'test',
        dispatchesCli: false,
        requires: [],
        provides: [],
        ...(stepId === 'a' ? { loopBudgetEditable: true } : {}),
      },
    })),
    bases: [
      { slug: 'workflow', eligibility: { eligible: true }, orderedBaseLists: candidates },
      {
        slug: 'run_app',
        eligibility: {
          eligible: false,
          reason: 'run-app-mode-selection-unavailable',
          message: 'Runtime mode is chosen after creation.',
        },
      },
    ],
  };
  return { catalog, candidates };
}
