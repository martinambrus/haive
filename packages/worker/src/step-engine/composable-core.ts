import {
  CORE_STAGE_INPUTS,
  SPEC_INPUTS,
  DISCOVERY_REQUIREMENTS_INPUTS,
} from '@haive/shared/step-ports';
import {
  SPEC_ROLES,
  DISCOVERY_ROLE,
  REQUIREMENTS_ROLES,
  DISCOVERY_OUTPUT_CONTRACT,
  REQUIREMENTS_DRAFT_OUTPUT_CONTRACT,
  REQUIREMENTS_HUMANIZED_OUTPUT_CONTRACT,
  STEP_ROLE_REGISTRY,
  SPEC_DRAFT_OUTPUT_CONTRACT,
  SPEC_CHECKED_OUTPUT_CONTRACT,
  SPEC_RESOLVED_OUTPUT_CONTRACT,
  type StepRoleId,
  type StepOutputContractRef,
  CODE_REVIEW_OUTPUT_CONTRACT,
  CODE_AUDIT_OUTPUT_CONTRACT,
} from '@haive/shared/step-outputs';
import {
  composableStepEntrySchema,
  IMPLICIT_COMPOSITION_TOKENS,
  type ComposableStepEntry,
} from '@haive/shared/modularity';
import type { StepRegistry } from './registry.js';
import { dispatchesAnyCli, emitsLoop } from './steps/index.js';
import { FIX_LOOP_TARGET_STEP_ID } from './steps/workflow/_fix-loop.js';

const IMPLEMENT = '07-phase-2-implement';

const needRepository = (reason: string) => ({ needs: 'repository', reason });
const needWorktree = { needs: 'worktree', reason: 'Works inside the task worktree.' };
const EDITS_PRECEDE = [
  'validation',
  'tests',
  'verification',
  'review',
  'browser-verification',
  'code-audit',
  'adversarial-qa',
  'verify-approved',
  'commit',
  'reindexed',
  'db-saved',
  'reconciled',
  'learnings',
  'rag-scope',
];

/** Core-only port declarations; manifest/SDK ports arrive with v3 admission. */
export type CoreComposableStepEntry = ComposableStepEntry & {
  providesRoles?: readonly { role: StepRoleId; contract: StepOutputContractRef }[];
  consumesRoles?: readonly {
    input: string;
    role: StepRoleId;
    contract: StepOutputContractRef;
    optional: boolean;
  }[];
};
export const CORE_COMPOSABLE_STEPS: readonly CoreComposableStepEntry[] = [
  {
    stepId: '01-declare-deps',
    agentAuthoredOutput: true,
    label: 'Declare dependencies',
    group: 'env',
    dispatchesCli: false,
    requires: [needRepository('Reads the dependencies declared by the repository.')],
    provides: ['env-deps'],
    entails: ['env-image'],
    precedes: ['worktree', 'discovery', 'spec', 'cleaned'],
  },
  {
    stepId: '02-generate-dockerfile',
    agentAuthoredOutput: true,
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
    precedes: ['worktree', 'discovery', 'spec', 'browser-choice', 'cleaned'],
  },
  {
    stepId: '04-verify-environment',
    agentAuthoredOutput: true,
    label: 'Verify environment',
    group: 'env',
    dispatchesCli: false,
    requires: [{ needs: 'env-image', reason: 'Checks the built, ready image.' }],
    provides: [],
    precedes: [
      'app-runtime',
      'implementation',
      'discovery',
      'spec',
      'commit',
      'learnings',
      'skills-synced',
      'cleaned',
    ],
  },
  {
    stepId: '00-model-health-workflow',
    label: 'Model health check',
    group: 'setup',
    dispatchesCli: true,
    requires: [],
    provides: ['model-health'],
    precedes: ['execution-path', 'env-deps', 'worktree', 'discovery', 'spec', 'implementation'],
  },
  {
    stepId: '00-triage',
    label: 'Choose execution path',
    group: 'setup',
    dispatchesCli: true,
    requires: [],
    provides: ['execution-path'],
    // Static types keep their snapshot; this still records the path and broad-audit choice.
    precedes: ['effort-estimated', 'env-deps', 'worktree', 'discovery', 'spec', 'implementation'],
  },
  {
    stepId: '00b-estimate',
    label: 'Estimate effort',
    group: 'setup',
    dispatchesCli: true,
    // Repository history and the triage path are optional; both have explicit fallbacks.
    requires: [],
    provides: ['effort-estimated'],
    precedes: ['sprint-plan', 'implementation'],
  },
  {
    stepId: '00a-sync-base',
    label: 'Sync base with origin',
    group: 'setup',
    dispatchesCli: true,
    requires: [needRepository('Syncs the repository base branch with origin.')],
    provides: [],
    precedes: ['worktree', 'discovery', 'spec', 'env-deps', 'env-dockerfile', 'env-image'],
  },
  {
    stepId: '01-worktree-setup',
    label: 'Worktree setup',
    group: 'setup',
    dispatchesCli: false,
    requires: [needRepository('Cuts the worktree from the repository.')],
    provides: ['worktree', 'clean-tree'],
  },
  {
    stepId: '01-debug-mode',
    agentAuthoredOutput: true,
    label: 'Debug mode',
    group: 'setup',
    dispatchesCli: false,
    requires: [],
    provides: [],
    precedes: ['app-runtime', 'implementation'],
  },
  {
    stepId: '01b-install-plugins',
    agentAuthoredOutput: true,
    label: 'Install CLI plugins',
    group: 'setup',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: [],
    precedes: [
      'discovery',
      'spec',
      'implementation',
      'commit',
      'learnings',
      'skills-synced',
      'app-runtime',
    ],
  },
  {
    stepId: '01d-browser-access',
    agentAuthoredOutput: true,
    label: 'Browser access',
    group: 'runtime',
    dispatchesCli: false,
    requires: [],
    provides: ['browser-choice'],
    precedes: ['app-runtime', 'implementation'],
  },
  {
    stepId: '01c-ddev-env',
    label: 'DDEV environment',
    group: 'runtime',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: ['ddev', 'app-runtime'],
    entails: ['db-restored', 'db-saved'],
    removes: ['clean-tree'],
    precedes: [
      'implementation',
      'commit',
      'rag-scope',
      'reindexed',
      'learnings',
      'validation',
      'tests',
      'verification',
      'review',
      'db-saved',
      'reconciled',
    ],
  },
  {
    stepId: '01a-app-boot',
    label: 'App boot',
    group: 'runtime',
    dispatchesCli: true,
    requires: [needWorktree, { needs: 'env-image', reason: 'Boots the app from the ready image.' }],
    provides: ['app-runtime'],
    removes: ['clean-tree'],
    precedes: [
      'implementation',
      'validation',
      'tests',
      'verification',
      'review',
      'commit',
      'reindexed',
      'db-saved',
      'reconciled',
      'learnings',
      'rag-scope',
    ],
  },
  {
    stepId: '01c1-restore-database',
    agentAuthoredOutput: true,
    label: 'Restore database',
    group: 'runtime',
    dispatchesCli: false,
    requires: [{ needs: 'ddev', reason: 'Imports the dump into the DDEV project.' }],
    provides: ['db-restored'],
    precedes: [
      'db-migrated',
      'implementation',
      'tests',
      'verification',
      'db-saved',
      'cleaned',
      'discovery',
      'spec',
      'commit',
      'learnings',
      'skills-synced',
    ],
  },
  {
    stepId: '06a-db-migrate',
    label: 'Database migrations',
    group: 'runtime',
    dispatchesCli: false,
    requires: [{ needs: 'ddev', reason: 'Runs migrations inside the DDEV project.' }],
    provides: ['db-migrated'],
    precedes: [
      'implementation',
      'tests',
      'verification',
      'db-saved',
      'cleaned',
      'commit',
      'learnings',
      'skills-synced',
    ],
  },
  {
    stepId: '01e-external-kb-sync',
    label: 'Sync external knowledge-base changes',
    group: 'knowledge',
    dispatchesCli: true,
    requires: [
      needWorktree,
      needRepository('Measures external commits and updates the repository knowledge base.'),
    ],
    provides: ['external-kb-synced'],
    // Commits/reverts its own KB edits, without promising the rest of the tree is clean.
    precedes: ['pre-indexed', 'discovery', 'spec', 'learnings', 'pushed', 'cleaned'],
  },
  {
    stepId: '01f-external-plan-sync',
    label: 'Sync external plan changes',
    group: 'knowledge',
    dispatchesCli: true,
    requires: [
      needWorktree,
      needRepository('Measures external commits against the repository plan.'),
    ],
    provides: ['external-plan-synced'],
    precedes: ['discovery', 'spec', 'plan-reconciled', 'cleaned'],
  },
  {
    stepId: '01g-rag-source-selection',
    label: 'Choose pre-sync RAG scope',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [needRepository('Scans the repository root and saves its indexing scope.')],
    provides: ['pre-rag-scope'],
    // Distinct from rag-scope: this indexes the main checkout before implementation.
    precedes: ['pre-indexed'],
  },
  {
    stepId: '02-pre-rag-sync',
    label: 'Pre-workflow RAG sync',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [
      needRepository('Indexes code and knowledge files from the repository root.'),
      { needs: 'pre-rag-scope', reason: 'Indexes only after the repository scope is reviewed.' },
    ],
    provides: ['pre-indexed'],
    precedes: ['discovery', 'spec', 'implementation'],
  },
  {
    stepId: '03-phase-0a-discovery',
    providesRoles: [{ role: DISCOVERY_ROLE, contract: DISCOVERY_OUTPUT_CONTRACT }],
    label: 'Phase 0a: Knowledge discovery',
    group: 'spec',
    dispatchesCli: true,
    requires: [],
    provides: ['discovery'],
    precedes: ['business-requirements', 'spec'],
  },
  {
    stepId: '03b-business-requirements',
    providesRoles: [
      { role: REQUIREMENTS_ROLES.draft, contract: REQUIREMENTS_DRAFT_OUTPUT_CONTRACT },
    ],
    agentAuthoredOutput: true,
    label: 'Draft business requirements',
    group: 'spec',
    dispatchesCli: true,
    // Discovery is optional context; the task brief is sufficient to draft requirements.
    requires: [],
    provides: ['business-requirements'],
    precedes: ['requirements-humanized', 'requirements-approved', 'spec'],
  },
  {
    stepId: '03b2-humanize-requirements',
    providesRoles: [
      { role: REQUIREMENTS_ROLES.humanized, contract: REQUIREMENTS_HUMANIZED_OUTPUT_CONTRACT },
    ],
    agentAuthoredOutput: true,
    label: 'Humanize business requirements',
    group: 'spec',
    dispatchesCli: true,
    requires: [{ needs: 'business-requirements', reason: 'Rewrites the draft stored by 03b.' }],
    provides: ['requirements-humanized'],
    precedes: ['requirements-approved', 'spec'],
  },
  {
    stepId: '03c-business-requirements-review',
    label: 'Review business requirements',
    group: 'spec',
    dispatchesCli: false,
    requires: [
      { needs: 'business-requirements', reason: 'Reviews the draft; humanization is optional.' },
    ],
    provides: ['requirements-approved'],
    precedes: ['spec'],
    loopTargetStepId: '03b-business-requirements',
  },
  {
    stepId: '04-phase-0b-pre-planning',
    providesRoles: [{ role: SPEC_ROLES.draft, contract: SPEC_DRAFT_OUTPUT_CONTRACT }],
    label: 'Phase 0b: Pre-planning',
    group: 'spec',
    dispatchesCli: true,
    requires: [],
    provides: ['spec'],
    precedes: ['sprint-plan', 'implementation'],
  },
  {
    stepId: '04a-spec-audit',
    agentAuthoredOutput: true,
    label: 'Spec audit (broad)',
    group: 'spec',
    dispatchesCli: true,
    requires: [{ needs: 'spec', reason: 'Audits the pre-planning draft read by step id.' }],
    provides: ['spec-audit'],
    precedes: ['spec-reviewed', 'spec-warnings-resolved', 'spec-approved', 'implementation'],
  },
  {
    stepId: '05-phase-0b5-spec-quality',
    providesRoles: [{ role: SPEC_ROLES.checked, contract: SPEC_CHECKED_OUTPUT_CONTRACT }],
    label: 'Phase 0b.5: Spec quality review',
    group: 'spec',
    dispatchesCli: true,
    requires: [{ needs: 'spec', reason: 'Reviews the pre-planning spec.' }],
    provides: ['spec', 'spec-reviewed'],
    precedes: ['spec-warnings-resolved', 'spec-approved', 'sprint-plan', 'implementation'],
    loopBudgetEditable: true,
  },
  {
    stepId: '05a-resolve-spec-warnings',
    providesRoles: [{ role: SPEC_ROLES.resolved, contract: SPEC_RESOLVED_OUTPUT_CONTRACT }],
    label: 'Resolve spec warnings',
    group: 'spec',
    dispatchesCli: true,
    // Quality and broad-audit findings are optional; the draft is the fallback body.
    requires: [
      needWorktree,
      { needs: 'spec', reason: 'Resolves findings against the drafted or reviewed spec.' },
    ],
    provides: ['spec', 'spec-warnings-resolved'],
    precedes: ['spec-approved', 'sprint-plan', 'implementation'],
  },
  {
    stepId: '06-gate-1-spec-approval',
    label: 'Gate 1: Spec approval',
    group: 'spec',
    dispatchesCli: false,
    requires: [{ needs: 'spec', reason: 'Asks for a decision on the spec.' }],
    provides: ['spec-approved'],
    precedes: ['sprint-plan', 'implementation'],
    loopTargetStepId: '04-phase-0b-pre-planning',
  },
  {
    stepId: '06-run-config',
    label: 'Run configuration',
    group: 'build',
    dispatchesCli: true,
    // Spec, worktree and runtime inputs are optional probes, with empty fallbacks.
    // No consumer requires this step: types may use presets without a config form.
    requires: [],
    provides: [],
    // These steps consume the downstream answers or task-level review/run settings.
    // Worktree, discovery and spec do not consume the answers 06 writes, and run
    // before 06 in the shipped workflow.
    precedes: [
      'sprint-plan',
      'browser-test-choice',
      'browser-verification',
      'adversarial-qa',
      'insights-triaged',
      'db-migrated',
      'implementation',
      'reconciled',
      'validation',
      'tests',
      'verification',
      'review',
    ],
  },
  {
    stepId: '06b-sprint-planning',
    label: 'Sprint planning',
    group: 'build',
    dispatchesCli: true,
    // Spec and gate-1 feedback have empty fallbacks; their producers order before planning.
    requires: [],
    provides: ['sprint-plan'],
    // The planner may choose DAG or single (including override and parse fallback).
    // Keep both routes available so its runtime choice always has an implementation.
    entails: ['dag-implementation', 'single-implementation'],
    precedes: ['implementation'],
  },
  {
    stepId: '06c-dag-execute',
    label: 'DAG implementation',
    group: 'build',
    dispatchesCli: true,
    requires: [
      needWorktree,
      {
        needs: 'sprint-plan',
        reason: 'Reads 06b mode and the task_dag_* rows it creates in DAG mode.',
      },
    ],
    provides: ['implementation', 'dag-implementation'],
    entailsWhen: [{ provided: 'ddev', entails: ['reconciled'] }],
    removes: ['clean-tree'],
    precedes: EDITS_PRECEDE,
  },
  {
    stepId: IMPLEMENT,
    label: 'Phase 2: Implement',
    group: 'build',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['implementation', 'single-implementation'],
    entailsWhen: [{ provided: 'ddev', entails: ['reconciled'] }],
    removes: ['clean-tree'],
    precedes: EDITS_PRECEDE,
  },
  {
    stepId: '07a-code-simplify',
    agentAuthoredOutput: true,
    label: 'Phase 3.5: Code simplification',
    group: 'build',
    dispatchesCli: true,
    requires: [
      needWorktree,
      { needs: 'implementation', reason: 'Simplifies the implemented changes.' },
    ],
    provides: [],
    removes: ['clean-tree'],
    precedes: EDITS_PRECEDE,
    loopBudgetEditable: true,
  },
  {
    stepId: '07b-phase-4-validate',
    agentAuthoredOutput: true,
    label: 'Phase 4: Implementation validation',
    group: 'check',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['validation'],
    precedes: [
      'verify-approved',
      'tests',
      'verification',
      'review',
      'commit',
      'reindexed',
      'db-saved',
      'learnings',
      'rag-scope',
    ],
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
    provides: ['reconciled'],
    precedes: ['validation', 'tests', 'verification', 'db-saved', 'learnings'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08b-test-management',
    label: 'Phase 5b: Test management',
    group: 'check',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['tests'],
    removes: ['clean-tree'],
    precedes: [
      'verify-approved',
      'verification',
      'review',
      'commit',
      'reindexed',
      'db-saved',
      'learnings',
      'rag-scope',
    ],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08-phase-5-verify',
    label: 'Phase 5: Verify',
    group: 'check',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: ['verification'],
    precedes: ['verify-approved', 'db-saved', 'learnings'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08a-browser-setup',
    label: 'Browser test method',
    group: 'check',
    dispatchesCli: false,
    requires: [
      {
        needs: 'app-runtime',
        reason: 'Offers browser methods for the DDEV or app-runner runtime.',
      },
    ],
    provides: ['browser-test-choice'],
    // Automated testing runs in 08a; manual/direct testing moves to gate 2.
    entails: ['browser-verification', 'verify-approved'],
    precedes: ['browser-verification', 'verify-approved', 'commit'],
  },
  {
    stepId: '08a-browser-verify',
    label: 'Browser verification',
    group: 'check',
    dispatchesCli: true,
    requires: [
      needWorktree,
      { needs: 'app-runtime', reason: 'Tests the running DDEV or app-runner application.' },
    ],
    // The method has a legacy default when browser setup is absent.
    provides: ['browser-verification'],
    removes: ['clean-tree'],
    precedes: [
      'review',
      'code-audit',
      'adversarial-qa',
      'verify-approved',
      'commit',
      'db-saved',
      'learnings',
    ],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08c-code-review',
    outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
    agentAuthoredOutput: true,
    label: 'Phase 6: Code review',
    group: 'check',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['review'],
    precedes: ['verify-approved', 'db-saved', 'learnings'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08c2-code-audit',
    outputContract: CODE_AUDIT_OUTPUT_CONTRACT,
    agentAuthoredOutput: true,
    label: 'Code audit (broad)',
    group: 'check',
    dispatchesCli: true,
    // Spec and peer review are optional; an absent spec falls back to the task brief.
    requires: [needWorktree],
    provides: ['code-audit'],
    precedes: ['verify-approved', 'commit', 'db-saved', 'learnings'],
  },
  {
    stepId: '08d-adversarial-qa',
    label: 'Adversarial QA',
    group: 'check',
    dispatchesCli: true,
    // Can attack code without a live app; browser/login/spec/DAG debt are optional context.
    requires: [needWorktree],
    provides: ['adversarial-qa'],
    precedes: ['qa-reviewed', 'verify-approved', 'commit', 'db-saved', 'learnings'],
  },
  {
    stepId: '08d2-adversarial-qa-review',
    label: 'Review adversarial QA',
    group: 'check',
    dispatchesCli: false,
    requires: [{ needs: 'adversarial-qa', reason: 'Reviews the findings stored by 08d.' }],
    provides: ['qa-reviewed'],
    precedes: ['verify-approved', 'commit'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '08e-insights-triage',
    label: 'Triage insights',
    group: 'check',
    dispatchesCli: true,
    requires: [
      needWorktree,
      { needs: 'verification', reason: 'Revises through verification.' },
      {
        needs: 'review',
        after: 'verification',
        reason: 'Insight continuations verify before code review.',
      },
    ],
    loopTargetStepId: '08-phase-5-verify',
    provides: ['insights-triaged'],
    removes: ['clean-tree'],
    // Runs AFTER reviews in the shipped order; selected insights can still edit code.
    precedes: ['verify-approved', 'commit', 'learnings', 'pushed', 'cleaned'],
  },
  {
    stepId: '09-gate-2-verify-approval',
    label: 'Gate 2: Verify approval',
    group: 'check',
    dispatchesCli: false,
    requires: [needWorktree],
    // Verification/audit/review/QA/browser reports are optional sections, read by their core ids.
    provides: ['verify-approved'],
    precedes: ['commit'],
    loopTargetStepId: IMPLEMENT,
  },
  {
    stepId: '10-gate-3-commit',
    loopBeforeClose: true,
    loopTargetStepId: '08e-insights-triage',
    loopTargetWhenPresent: true,
    closes: true,
    label: 'Gate 3: Commit',
    group: 'finish',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['commit', 'clean-tree'],
    precedes: ['learnings'],
  },
  {
    stepId: '11-phase-8-learning',
    label: 'Phase 8: Learning capture',
    group: 'knowledge',
    dispatchesCli: true,
    requires: [needWorktree],
    provides: ['learnings'],
    removes: ['clean-tree'],
    precedes: ['pushed', 'reindexed', 'rag-scope'],
    loopTargetStepId: '11-phase-8-learning',
  },
  {
    stepId: '11d-skill-sync',
    agentAuthoredOutput: true,
    label: 'Sync skills',
    group: 'knowledge',
    dispatchesCli: true,
    requires: [
      needWorktree,
      { needs: 'learnings', reason: 'Applies the skill changes learning approved.' },
    ],
    provides: ['skills-synced'],
    removes: ['clean-tree'],
    precedes: ['knowledge-committed', 'pushed', 'reindexed', 'rag-scope'],
  },
  {
    stepId: '11b-kb-commit',
    label: 'Commit knowledge base',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [needWorktree, { needs: 'learnings', reason: 'Commits the captured learnings.' }],
    // Skill sync is optional (absent on plan_tasklist); it must precede this when present.
    provides: ['clean-tree', 'knowledge-committed'],
    precedes: ['pushed', 'rag-scope', 'reindexed'],
  },
  {
    stepId: '11b1-rag-source-selection',
    label: 'Choose RAG index scope',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [needWorktree],
    provides: ['rag-scope'],
  },
  {
    stepId: '11c-rag-reindex',
    agentAuthoredOutput: true,
    label: 'Re-index knowledge base into RAG',
    group: 'knowledge',
    dispatchesCli: false,
    requires: [
      needWorktree,
      { needs: 'rag-scope', reason: 'Indexes only after the RAG scope is chosen.' },
    ],
    provides: ['reindexed'],
  },
  {
    stepId: '11e-prompt-guidance',
    label: 'Capture prompt guidance',
    group: 'knowledge',
    dispatchesCli: false,
    // Scans task invocation outputs and writes guidance rows; repo facets are optional.
    requires: [],
    provides: ['prompt-guidance'],
  },
  {
    stepId: '11f-plan-reconcile',
    label: 'Reconcile project plan',
    group: 'knowledge',
    dispatchesCli: true,
    requires: [
      needWorktree,
      needRepository('Reconciles the repository plan and writes its mirror.'),
    ],
    // Missing plan/spec/committed changedPaths have explicit empty/worktree fallbacks.
    provides: ['plan-reconciled'],
    precedes: ['pushed', 'cleaned'],
  },
  {
    stepId: '11a-gate-4-push',
    closes: true,
    label: 'Gate 4: Push',
    group: 'finish',
    dispatchesCli: false,
    requires: [
      needWorktree,
      { needs: 'commit', reason: 'Pushes the committed work.' },
      { needs: 'clean-tree', reason: 'Nothing may be left uncommitted.' },
    ],
    provides: ['pushed'],
    precedes: ['db-saved'],
  },
  {
    stepId: '11g-save-database',
    agentAuthoredOutput: true,
    label: 'Save database',
    group: 'finish',
    dispatchesCli: false,
    requires: [{ needs: 'ddev', reason: 'Saves the DDEV project database.' }],
    provides: ['db-saved'],
    precedes: ['cleaned'],
  },
  {
    stepId: '12-worktree-cleanup',
    closes: true,
    label: 'Worktree cleanup',
    group: 'finish',
    dispatchesCli: true,
    requires: [
      { needs: 'commit', reason: 'Merges or opens a PR for the committed work.' },
      { needs: 'clean-tree', reason: 'Nothing may be left uncommitted.' },
    ],
    provides: ['pr', 'cleaned'],
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
].map((entry) => ({
  ...entry,
  ...(CORE_STAGE_INPUTS[entry.stepId] ? { consumesRoles: CORE_STAGE_INPUTS[entry.stepId] } : {}),
})) as readonly CoreComposableStepEntry[];

export function assertCoreComposableCatalog(
  registry: StepRegistry,
  entries: readonly ComposableStepEntry[] = CORE_COMPOSABLE_STEPS,
): void {
  assertSpecPortDeclarations(entries as readonly CoreComposableStepEntry[]);
  assertDiscoveryRequirementsPortDeclarations(entries as readonly CoreComposableStepEntry[]);
  const ids = new Set(entries.map((e) => e.stepId));
  const provided = new Set(entries.flatMap((e) => e.provides));
  for (const entry of entries) {
    const parsed = composableStepEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`Composable core entry ${entry.stepId} is invalid: ${parsed.error.message}`);
    }
    const def = registry.get(entry.stepId);
    if (!def) throw new Error(`Composable core entry ${entry.stepId} is not a registered step`);
    const expected = dispatchesAnyCli(def);
    if (entry.dispatchesCli !== expected) {
      throw new Error(
        `Composable core entry ${entry.stepId} declares dispatchesCli=${entry.dispatchesCli}, expected ${expected}`,
      );
    }
    for (const { needs } of entry.requires) {
      if (!provided.has(needs) && !IMPLICIT_COMPOSITION_TOKENS.has(needs)) {
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

/** Fail boot if a provider disappeared or input names/optionality drifted. */
export function assertSpecPortDeclarations(
  entries: readonly CoreComposableStepEntry[] = CORE_COMPOSABLE_STEPS,
): void {
  for (const role of Object.values(SPEC_ROLES)) {
    const providers = entries.flatMap((e) =>
      (e.providesRoles ?? []).filter((p) => p.role === role).map((p) => ({ entry: e, port: p })),
    );
    const expected = STEP_ROLE_REGISTRY[role];
    if (
      providers.length !== 1 ||
      providers[0]!.entry.stepId !== expected.legacyStepId ||
      JSON.stringify(providers[0]!.port.contract) !== JSON.stringify(expected.contract)
    )
      throw new Error(`spec-port-provider-invalid: ${role}`);
  }
  for (const e of entries) {
    if (
      JSON.stringify(
        (e.consumesRoles ?? []).filter((p) => Object.values(SPEC_ROLES).includes(p.role as never)),
      ) !== JSON.stringify(SPEC_INPUTS[e.stepId] ?? [])
    )
      throw new Error(`spec-port-input-invalid: ${e.stepId}`);
  }
  for (const id of Object.keys(SPEC_INPUTS))
    if (!entries.some((e) => e.stepId === id)) throw new Error(`spec-port-consumer-missing: ${id}`);
}

/** New stages must keep their canonical writers and tolerant optional inputs at boot. */
export function assertDiscoveryRequirementsPortDeclarations(
  entries: readonly CoreComposableStepEntry[] = CORE_COMPOSABLE_STEPS,
): void {
  for (const role of [DISCOVERY_ROLE, ...Object.values(REQUIREMENTS_ROLES)]) {
    const providers = entries.flatMap((e) =>
      (e.providesRoles ?? []).filter((p) => p.role === role).map((p) => ({ entry: e, port: p })),
    );
    const expected = STEP_ROLE_REGISTRY[role];
    if (
      providers.length !== 1 ||
      providers[0]!.entry.stepId !== expected.legacyStepId ||
      JSON.stringify(providers[0]!.port.contract) !== JSON.stringify(expected.contract)
    )
      throw new Error(`discovery-requirements-port-provider-invalid: ${role}`);
  }
  for (const e of entries) {
    const inputs = (e.consumesRoles ?? []).filter(
      (p) => !Object.values(SPEC_ROLES).includes(p.role as never),
    );
    if (JSON.stringify(inputs) !== JSON.stringify(DISCOVERY_REQUIREMENTS_INPUTS[e.stepId] ?? []))
      throw new Error(`discovery-requirements-port-input-invalid: ${e.stepId}`);
  }
  for (const id of Object.keys(DISCOVERY_REQUIREMENTS_INPUTS))
    if (!entries.some((e) => e.stepId === id))
      throw new Error(`discovery-requirements-port-consumer-missing: ${id}`);
}
