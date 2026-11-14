import type { ComposableStepEntry } from '../src/modularity/contracts.js';
import type { DerivedChange } from '../src/modularity/derived-changes.js';

export function derivedOverlayInputs() {
  const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
  const entries: ComposableStepEntry[] = [
    ...prefix,
    'a',
    'b',
    'c',
    'x',
    'y',
    'module.example.check',
  ].map((stepId) => ({
    stepId,
    label: stepId,
    group: 'test',
    dispatchesCli: false,
    requires: [],
    provides: [],
    ...(stepId === 'a' ? { loopBudgetEditable: true } : {}),
  }));
  return {
    prefix,
    entries,
    baseCandidates: [
      { executionPath: null, stepIds: [...prefix, 'a', 'b'] },
      { executionPath: 'quick_bugfix' as const, stepIds: [...prefix, 'a'] },
    ],
  };
}

interface OverlayCase {
  name: string;
  changes: DerivedChange[];
  omitDeclarations?: string[];
  omitInstalled?: string[];
  expected: {
    steps: string[][];
    outcomes: string[][];
    issueKinds: string[];
    warningKinds: string[];
  };
}
const prefix = ['00-model-health-workflow', '00a-sync-base', '00-triage'];
const unchanged = [
  [...prefix, 'a', 'b'],
  [...prefix, 'a'],
];

// These expectations are recorded independently of the evaluator. Both shared evaluation
// and the web catalog adapter consume them, so neither computes the other's oracle.
export const derivedOverlayCases: OverlayCase[] = [
  {
    name: 'empty overlay preserves ordered candidates',
    changes: [],
    expected: { steps: unchanged, outcomes: [[], []], issueKinds: [], warningKinds: [] },
  },
  {
    name: 'inserted anchors and path-specific removal',
    changes: [{ insertAfter: 'a', step: 'x' }, { insertAfter: 'x', step: 'y' }, { remove: 'b' }],
    expected: {
      steps: [
        [...prefix, 'a', 'x', 'y'],
        [...prefix, 'a', 'x', 'y'],
      ],
      outcomes: [
        ['applied', 'applied', 'applied'],
        ['applied', 'applied', 'path-absent'],
      ],
      issueKinds: [],
      warningKinds: [],
    },
  },
  {
    name: 'later insert stays nearest its anchor',
    changes: [
      { insertAfter: 'a', step: 'x' },
      { insertAfter: 'a', step: 'y' },
    ],
    expected: {
      steps: [
        [...prefix, 'a', 'y', 'x', 'b'],
        [...prefix, 'a', 'y', 'x'],
      ],
      outcomes: [
        ['applied', 'applied'],
        ['applied', 'applied'],
      ],
      issueKinds: [],
      warningKinds: [],
    },
  },
  {
    name: 'consumed and stale targets stay distinct',
    changes: [{ remove: 'b' }, { insertAfter: 'b', step: 'x' }, { remove: 'old-name' }],
    expected: {
      steps: [
        [...prefix, 'a'],
        [...prefix, 'a'],
      ],
      outcomes: [
        ['applied', 'refused', 'stale-target'],
        ['path-absent', 'path-absent', 'stale-target'],
      ],
      issueKinds: ['target-removed-by-change'],
      warningKinds: ['stale-target'],
    },
  },
  {
    name: 'stale producers propagate their skip',
    changes: [
      { insertAfter: 'old-name', step: 'x' },
      { insertAfter: 'x', step: 'y' },
    ],
    expected: {
      steps: unchanged,
      outcomes: [
        ['stale-target', 'stale-target'],
        ['stale-target', 'stale-target'],
      ],
      issueKinds: [],
      warningKinds: ['stale-target'],
    },
  },
  {
    name: 'active replacement requires an output contract',
    changes: [{ replace: 'a', with: 'x' }],
    expected: {
      steps: unchanged,
      outcomes: [['refused'], ['refused']],
      issueKinds: ['replacement-contract-unavailable'],
      warningKinds: [],
    },
  },
  {
    name: 'prefix remains protected',
    changes: [{ remove: '00-triage' }],
    expected: {
      steps: unchanged,
      outcomes: [['refused'], ['refused']],
      issueKinds: ['protected-prefix-edit'],
      warningKinds: [],
    },
  },
  {
    name: 'uninstalled payload is refused',
    changes: [{ insertAfter: 'a', step: 'missing' }],
    expected: {
      steps: unchanged,
      outcomes: [['refused'], ['refused']],
      issueKinds: ['missing-installed-step'],
      warningKinds: [],
    },
  },
  {
    name: 'installed IDs come from registration rather than declarations',
    changes: [],
    omitInstalled: ['a'],
    expected: {
      steps: unchanged,
      outcomes: [[], []],
      issueKinds: ['missing-installed-step'],
      warningKinds: [],
    },
  },
  {
    name: 'missing declarations remain composition errors',
    changes: [],
    omitDeclarations: ['b'],
    expected: {
      steps: unchanged,
      outcomes: [[], []],
      issueKinds: ['invalid-composition'],
      warningKinds: [],
    },
  },
  {
    name: 'duplicate resulting IDs are refused',
    changes: [{ insertAfter: 'a', step: 'b' }],
    expected: {
      steps: [
        [...prefix, 'a', 'b', 'b'],
        [...prefix, 'a', 'b'],
      ],
      outcomes: [['applied'], ['applied']],
      issueKinds: ['duplicate-resulting-id', 'invalid-composition'],
      warningKinds: [],
    },
  },
];
