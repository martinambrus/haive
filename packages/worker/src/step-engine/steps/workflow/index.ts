import type { StepRegistry } from '../../registry.js';
import { makeModelHealthStep } from '../_model-health.js';
import { syncBaseStep } from './00a-sync-base.js';
import { triageStep } from './00-triage.js';
import { worktreeSetupStep } from './01-worktree-setup.js';
import { debugModeStep } from './01-debug-mode.js';
import { installPluginsStep } from './01b-install-plugins.js';
import { browserAccessStep } from './01d-browser-access.js';
import { appBootStep } from './01a-app-boot.js';
import { ddevEnvStep } from './01c-ddev-env.js';
import { preRagSyncStep } from './02-pre-rag-sync.js';
import { phase0aDiscoveryStep } from './03-phase-0a-discovery.js';
import { businessRequirementsStep } from './03b-business-requirements.js';
import { humanizeRequirementsStep } from './03b2-humanize-requirements.js';
import { businessRequirementsReviewStep } from './03c-business-requirements-review.js';
import { phase0bPrePlanningStep } from './04-phase-0b-pre-planning.js';
import { specAuditStep } from './04a-spec-audit.js';
import { phase0b5SpecQualityStep } from './05-phase-0b5-spec-quality.js';
import { resolveSpecWarningsStep } from './05a-resolve-spec-warnings.js';
import { gate1SpecApprovalStep } from './06-gate-1-spec-approval.js';
import { runConfigStep } from './06-run-config.js';
import { dbMigrateStep } from './06a-db-migrate.js';
import { sprintPlanningStep } from './06b-sprint-planning.js';
import { dagExecuteStep } from './06c-dag-execute.js';
import { phase2ImplementStep } from './07-phase-2-implement.js';
import { codeSimplifyStep } from './07a-code-simplify.js';
import { phase4ValidateStep } from './07b-phase-4-validate.js';
import { ddevReconcileStep } from './07c-ddev-reconcile.js';
import { phase5VerifyStep } from './08-phase-5-verify.js';
import { browserSetupStep } from './08a-browser-setup.js';
import { browserVerifyStep } from './08a-browser-verify.js';
import { testManagementStep } from './08b-test-management.js';
import { codeReviewStep } from './08c-code-review.js';
import { codeAuditStep } from './08c2-code-audit.js';
import { adversarialQaStep } from './08d-adversarial-qa.js';
import { adversarialQaReviewStep } from './08d2-adversarial-qa-review.js';
import { insightsTriageStep } from './08e-insights-triage.js';
import { gate2VerifyApprovalStep } from './09-gate-2-verify-approval.js';
import { gate3CommitStep } from './10-gate-3-commit.js';
import { phase8LearningStep } from './11-phase-8-learning.js';
import { kbCommitStep } from './11b-kb-commit.js';
import { ragReindexStep } from './11c-rag-reindex.js';
import { gate4PushStep } from './11a-gate-4-push.js';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';

export {
  syncBaseStep,
  triageStep,
  worktreeSetupStep,
  debugModeStep,
  installPluginsStep,
  browserAccessStep,
  appBootStep,
  ddevEnvStep,
  preRagSyncStep,
  phase0aDiscoveryStep,
  businessRequirementsStep,
  humanizeRequirementsStep,
  businessRequirementsReviewStep,
  phase0bPrePlanningStep,
  specAuditStep,
  phase0b5SpecQualityStep,
  resolveSpecWarningsStep,
  gate1SpecApprovalStep,
  runConfigStep,
  dbMigrateStep,
  sprintPlanningStep,
  dagExecuteStep,
  phase2ImplementStep,
  codeSimplifyStep,
  phase4ValidateStep,
  ddevReconcileStep,
  phase5VerifyStep,
  browserSetupStep,
  browserVerifyStep,
  testManagementStep,
  codeReviewStep,
  codeAuditStep,
  adversarialQaStep,
  adversarialQaReviewStep,
  insightsTriageStep,
  gate2VerifyApprovalStep,
  gate3CommitStep,
  phase8LearningStep,
  kbCommitStep,
  ragReindexStep,
  gate4PushStep,
  worktreeCleanupStep,
};

export function registerWorkflowSteps(registry: StepRegistry): void {
  registry.register(makeModelHealthStep('workflow'));
  registry.register(syncBaseStep);
  registry.register(triageStep);
  registry.register(worktreeSetupStep);
  registry.register(debugModeStep);
  registry.register(installPluginsStep);
  registry.register(browserAccessStep);
  registry.register(appBootStep);
  registry.register(ddevEnvStep);
  registry.register(preRagSyncStep);
  registry.register(phase0aDiscoveryStep);
  registry.register(businessRequirementsStep);
  registry.register(humanizeRequirementsStep);
  registry.register(businessRequirementsReviewStep);
  registry.register(phase0bPrePlanningStep);
  registry.register(specAuditStep);
  registry.register(phase0b5SpecQualityStep);
  registry.register(resolveSpecWarningsStep);
  registry.register(gate1SpecApprovalStep);
  registry.register(runConfigStep);
  registry.register(dbMigrateStep);
  registry.register(sprintPlanningStep);
  registry.register(dagExecuteStep);
  registry.register(phase2ImplementStep);
  registry.register(codeSimplifyStep);
  registry.register(phase4ValidateStep);
  registry.register(ddevReconcileStep);
  registry.register(phase5VerifyStep);
  registry.register(browserSetupStep);
  registry.register(browserVerifyStep);
  registry.register(testManagementStep);
  registry.register(codeReviewStep);
  registry.register(codeAuditStep);
  registry.register(adversarialQaStep);
  registry.register(adversarialQaReviewStep);
  registry.register(insightsTriageStep);
  registry.register(gate2VerifyApprovalStep);
  registry.register(gate3CommitStep);
  registry.register(phase8LearningStep);
  registry.register(kbCommitStep);
  registry.register(ragReindexStep);
  registry.register(gate4PushStep);
  registry.register(worktreeCleanupStep);
}
