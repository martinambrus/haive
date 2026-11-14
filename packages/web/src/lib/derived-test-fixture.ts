import { derivedOverlayInputs } from '../../../shared/test/derived-overlay-fixtures';
import type { TaskTypeCatalog } from './api-client';
export function derivedFixture() {
  const { entries, baseCandidates: candidates } = derivedOverlayInputs();
  const catalog: TaskTypeCatalog = {
    synced: true,
    modules: [],
    groups: [{ id: 'test', label: 'Test' }],
    registeredStepIds: entries.map((entry) => entry.stepId),
    steps: entries.map((entry) => ({
      stepId: entry.stepId,
      source: 'builtin',
      title: entry.label,
      entry,
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
