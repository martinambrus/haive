import { composableStepEntrySchema, type ComposableStepEntry } from '@haive/shared/modularity';
import type { StepRegistry } from './registry.js';
import { dispatchesCli, emitsLoop } from './steps/index.js';
import { FIX_LOOP_TARGET_STEP_ID } from './steps/workflow/_fix-loop.js';

const IMPLEMENT = '07-phase-2-implement';

export const MERGE_CAPABLE_STEP_IDS: readonly string[] = ['00a-sync-base', '12-worktree-cleanup'];

const needWorktree = { needs: 'worktree', reason: 'Works inside the task worktree.' };

export const CORE_COMPOSABLE_STEPS: readonly ComposableStepEntry[] = [
  {
    stepId: '01-declare-deps',
    label: 'Declare dependencies',
    group: 'env',
    dispatchesCli: false,
    requires: [],
    provides: ['env-deps'],
  },
  {
    stepId: '02-generate-dockerfile',
    label: 'Generate Dockerfile',
    group: 'env',
    dispatchesCli: false,
    requires: [
      { needs: 'env-deps', reason: 'Builds the Dockerfile from the declared dependencies.' },
    ],
    provides: ['env-dockerfile'],
  },
  {
    stepId: '03-build-image',
    label: 'Build environment image',
    group: 'env',
    dispatchesCli: false,
    requires: [{ needs: 'env-dockerfile', reason: 'Fails without a generated Dockerfile.' }],
    provides: ['env-image'],
  },
  {
    stepId: '04-verify-environment',
    label: 'Verify environment',
    group: 'env',
    dispatchesCli: false,
    requires: [{ needs: 'env-image', reason: 'Checks the built, ready image.' }],
    provides: [],
  },
  {
    stepId: '00a-sync-base',
    label: 'Sync base with origin',
    group: 'setup',
    dispatchesCli: true,
    requires: [],
    provides: [],
    precedes: ['worktree'],
  },
  {
    stepId: '01-worktree-setup',
    label: 'Worktree setup',
    group: 'setup',
    dispatchesCli: false,
    requires: [],
    provides: ['worktree'],
  },
  {
    stepId: '01-debug-mode',
    label: 'Debug mode',
    group: 'setup',
    dispatchesCli: false,
    requires: [],
    provides: [],
    precedes: ['app-runtime'],
  },
  {
    stepId: '01b-install-plugins',
    label: 'Install CLI plugins',
    group: 'setup',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: [],
  },
  {
    stepId: '01d-browser-access',
    label: 'Browser access',
    group: 'runtime',
    dispatchesCli: false,
    requires: [{ needs: 'env-deps', reason: 'Reads the declared browser-testing dependency.' }],
    provides: [],
    precedes: ['app-runtime'],
  },
  {
    stepId: '01c-ddev-env',
    label: 'DDEV environment',
    group: 'runtime',
    dispatchesCli: false,
    requires: [needWorktree, { needs: 'env-deps', reason: 'Reads the declared container tool.' }],
    provides: ['ddev', 'app-runtime'],
  },
  {
    stepId: '01a-app-boot',
    label: 'App boot',
    group: 'runtime',
    dispatchesCli: true,
    requires: [needWorktree, { needs: 'env-image', reason: 'Boots the app from the ready image.' }],
    provides: ['app-runtime'],
  },
  {
    stepId: '06a-db-migrate',
    label: 'Database migrations',
    group: 'runtime',
    dispatchesCli: false,
    requires: [{ needs: 'ddev', reason: 'Runs migrations inside the DDEV project.' }],
    provides: [],
  },
  {
    stepId: '03-phase-0a-discovery',
    label: 'Phase 0a: Knowledge discovery',
    group: 'spec',
    dispatchesCli: true,
    requires: [],
    provides: [],
  },
  {
    stepId: '04-phase-0b-pre-planning',
    label: 'Phase 0b: Pre-planning',
    group: 'spec',
    dispatchesCli: true,
    requires: [],
    provides: ['spec'],
  },
  {
    stepId: '05-phase-0b5-spec-quality',
    label: 'Phase 0b.5: Spec quality review',
    group: 'spec',
    dispatchesCli: true,
    requires: [{ needs: 'spec', reason: 'Reviews the pre-planning spec.' }],
    provides: ['spec'],
    loopBudgetEditable: true,
  },
  {
    stepId: '06-gate-1-spec-approval',
    label: 'Gate 1: Spec approval',
    group: 'spec',
    dispatchesCli: false,
    requires: [{ needs: 'spec', reason: 'Asks for a decision on the spec.' }],
    provides: ['spec-approved'],
    precedes: ['implementation'],
    loopTargetStepId: '04-phase-0b-pre-planning',
  },
  {
    stepId: IMPLEMENT,
    label: 'Phase 2: Implement',
    group: 'build',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['implementation'],
    precedes: ['commit', 'verification', 'review'],
  },
  {
    stepId: '07a-code-simplify',
    label: 'Phase 3.5: Code simplification',
    group: 'build',
    dispatchesCli: true,
    requires: [
      needWorktree,
      { needs: 'implementation', reason: 'Simplifies the implemented changes.' },
    ],
    provides: [],
    precedes: ['commit', 'verification', 'review'],
    loopBudgetEditable: true,
  },
  {
    stepId: '07b-phase-4-validate',
    label: 'Phase 4: Implementation validation',
    group: 'check',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: [],
    loopTargetStepId: IMPLEMENT,
    loopBudgetEditable: true,
  },
  {
    stepId: '07c-ddev-reconcile',
    label: 'DDEV reconcile',
    group: 'check',
    dispatchesCli: false,
    requires: [
      { needs: 'ddev', reason: 'Reconciles the running DDEV project.' },
      { needs: 'implementation', reason: 'Checks the implemented changes.' },
    ],
    provides: [],
    precedes: ['tests', 'verification'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08b-test-management',
    label: 'Phase 5b: Test management',
    group: 'check',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['tests'],
    precedes: ['verification', 'review'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08-phase-5-verify',
    label: 'Phase 5: Verify',
    group: 'check',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: ['verification'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08c-code-review',
    label: 'Phase 6: Code review',
    group: 'check',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['review'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '10-gate-3-commit',
    closes: true,
    label: 'Gate 3: Commit',
    group: 'finish',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['commit'],
  },
  {
    stepId: '11-phase-8-learning',
    label: 'Phase 8: Learning capture',
    group: 'knowledge',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['learnings'],
    precedes: ['pushed'],
    loopTargetStepId: '11-phase-8-learning',
  },
  {
    stepId: '11b-kb-commit',
    label: 'Commit knowledge base',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [needWorktree, { needs: 'learnings', reason: 'Commits the captured learnings.' }],
    provides: [],
    precedes: ['pushed'],
  },
  {
    stepId: '11c-rag-reindex',
    label: 'Re-index knowledge base into RAG',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: [],
  },
  {
    stepId: '11a-gate-4-push',
    closes: true,
    label: 'Gate 4: Push',
    group: 'finish',
    dispatchesCli: false,
    requires: [needWorktree, { needs: 'commit', reason: 'Pushes the committed work.' }],
    provides: ['pushed'],
  },
  {
    stepId: '12-worktree-cleanup',
    closes: true,
    label: 'Worktree cleanup',
    group: 'finish',
    dispatchesCli: true,
    requires: [{ needs: 'commit', reason: 'Merges or opens a PR for the committed work.' }],
    provides: ['pr'],
    removes: ['worktree'],
  },
  {
    stepId: '13-pr-wait',
    closes: true,
    label: 'Pull request',
    group: 'finish',
    dispatchesCli: true,
    requires: [{ needs: 'pr', reason: 'Waits on the pull request opened by cleanup.' }],
    provides: [],
  },
];

export function assertCoreComposableCatalog(
  registry: StepRegistry,
  entries: readonly ComposableStepEntry[] = CORE_COMPOSABLE_STEPS,
): void {
  const ids = new Set(entries.map((e) => e.stepId));
  const provided = new Set(entries.flatMap((e) => e.provides));
  for (const entry of entries) {
    const parsed = composableStepEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`Composable core entry ${entry.stepId} is invalid: ${parsed.error.message}`);
    }
    const def = registry.get(entry.stepId);
    if (!def) throw new Error(`Composable core entry ${entry.stepId} is not a registered step`);
    const expected = MERGE_CAPABLE_STEP_IDS.includes(entry.stepId) ? true : dispatchesCli(def);
    if (entry.dispatchesCli !== expected) {
      throw new Error(
        `Composable core entry ${entry.stepId} declares dispatchesCli=${entry.dispatchesCli}, expected ${expected}`,
      );
    }
    for (const { needs } of entry.requires) {
      if (!provided.has(needs)) {
        throw new Error(
          `Composable core entry ${entry.stepId} needs "${needs}", which no entry provides`,
        );
      }
    }
    if (emitsLoop(def) !== (entry.loopTargetStepId !== undefined)) {
      throw new Error(
        `Composable core entry ${entry.stepId} must declare a loop target exactly when its step loops`,
      );
    }
    if (
      (def.fixLoop || def.fixLoopOnError || def.restartLoop) &&
      entry.loopTargetStepId !== FIX_LOOP_TARGET_STEP_ID
    ) {
      throw new Error(
        `Composable core entry ${entry.stepId} loops back to ${FIX_LOOP_TARGET_STEP_ID}, not ${entry.loopTargetStepId}`,
      );
    }
    if (entry.loopTargetStepId !== undefined && !ids.has(entry.loopTargetStepId)) {
      throw new Error(
        `Composable core entry ${entry.stepId} loops to ${entry.loopTargetStepId}, which is not in the catalog`,
      );
    }
  }
}
