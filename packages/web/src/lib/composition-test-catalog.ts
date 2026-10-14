import type { ComposableStepEntry } from '@haive/shared/modularity';
import type { TaskTypeCatalog } from './api-client';

const entry = (e: Partial<ComposableStepEntry> & Pick<ComposableStepEntry, 'stepId' | 'label'>) =>
  ({
    group: 'spec',
    dispatchesCli: false,
    requires: [],
    provides: [],
    ...e,
  }) satisfies ComposableStepEntry;

const worktree = { needs: 'worktree', reason: 'Works inside the task worktree.' };

export const TEST_ENTRIES: ComposableStepEntry[] = [
  entry({
    stepId: '01-worktree-setup',
    label: 'Worktree setup',
    group: 'setup',
    provides: ['worktree'],
  }),
  entry({
    stepId: '03-phase-0a-discovery',
    label: 'Phase 0a: Knowledge discovery',
    dispatchesCli: true,
    provides: ['discovery'],
    precedes: ['spec'],
  }),
  entry({
    stepId: '04-phase-0b-pre-planning',
    label: 'Phase 0b: Pre-planning',
    dispatchesCli: true,
    provides: ['spec'],
  }),
  entry({
    stepId: '05-phase-0b5-spec-quality',
    label: 'Phase 0b.5: Spec quality review',
    dispatchesCli: true,
    requires: [{ needs: 'spec', reason: 'Reviews the pre-planning spec' }],
    provides: ['spec'],
    loopBudgetEditable: true,
  }),
  entry({
    stepId: '07-phase-2-implement',
    label: 'Phase 2: Implement',
    group: 'build',
    dispatchesCli: true,
    requires: [worktree],
    provides: ['implementation'],
  }),
  entry({
    stepId: '07b-phase-4-validate',
    label: 'Phase 4: Implementation validation',
    group: 'check',
    dispatchesCli: true,
    requires: [worktree],
    provides: ['validation'],
    loopTargetStepId: '07-phase-2-implement',
    loopBudgetEditable: true,
  }),
  entry({
    stepId: '09-finish',
    label: 'Finish',
    group: 'finish',
    requires: [worktree],
    closes: true,
    entails: ['finished'],
  }),
];

export const TEST_CATALOG: TaskTypeCatalog = {
  steps: TEST_ENTRIES.map((e) => ({ stepId: e.stepId, source: 'core', title: e.label, entry: e })),
  groups: [
    { id: 'setup', label: 'Setup' },
    { id: 'spec', label: 'Specification' },
    { id: 'build', label: 'Build' },
    { id: 'check', label: 'Checks' },
    { id: 'finish', label: 'Finish' },
  ],
  synced: true,
  modules: [],
  registeredStepIds: TEST_ENTRIES.map((e) => e.stepId),
};
