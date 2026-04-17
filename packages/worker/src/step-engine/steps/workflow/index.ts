import type { StepRegistry } from '../../registry.js';
import { worktreeSetupStep } from './01-worktree-setup.js';
import { installPluginsStep } from './01b-install-plugins.js';
import { appBootStep } from './01a-app-boot.js';
import { preRagSyncStep } from './02-pre-rag-sync.js';
import { phase0aDiscoveryStep } from './03-phase-0a-discovery.js';
import { phase0bPrePlanningStep } from './04-phase-0b-pre-planning.js';
import { phase0b5SpecQualityStep } from './05-phase-0b5-spec-quality.js';
import { gate1SpecApprovalStep } from './06-gate-1-spec-approval.js';
import { phase2ImplementStep } from './07-phase-2-implement.js';
import { phase5VerifyStep } from './08-phase-5-verify.js';
import { browserVerifyStep } from './08a-browser-verify.js';
import { gate2VerifyApprovalStep } from './09-gate-2-verify-approval.js';
import { gate3CommitStep } from './10-gate-3-commit.js';
import { phase8LearningStep } from './11-phase-8-learning.js';
import { worktreeCleanupStep } from './12-worktree-cleanup.js';

export {
  worktreeSetupStep,
  installPluginsStep,
  appBootStep,
  preRagSyncStep,
  phase0aDiscoveryStep,
  phase0bPrePlanningStep,
  phase0b5SpecQualityStep,
  gate1SpecApprovalStep,
  phase2ImplementStep,
  phase5VerifyStep,
  browserVerifyStep,
  gate2VerifyApprovalStep,
  gate3CommitStep,
  phase8LearningStep,
  worktreeCleanupStep,
};

export function registerWorkflowSteps(registry: StepRegistry): void {
  registry.register(worktreeSetupStep);
  registry.register(installPluginsStep);
  registry.register(appBootStep);
  registry.register(preRagSyncStep);
  registry.register(phase0aDiscoveryStep);
  registry.register(phase0bPrePlanningStep);
  registry.register(phase0b5SpecQualityStep);
  registry.register(gate1SpecApprovalStep);
  registry.register(phase2ImplementStep);
  registry.register(phase5VerifyStep);
  registry.register(browserVerifyStep);
  registry.register(gate2VerifyApprovalStep);
  registry.register(gate3CommitStep);
  registry.register(phase8LearningStep);
  registry.register(worktreeCleanupStep);
}
