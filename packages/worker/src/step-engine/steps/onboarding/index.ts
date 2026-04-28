import type { StepRegistry } from '../../registry.js';
import { envDetectStep } from './01-env-detect.js';
import { ripgrepConfigStep } from './01_5-ripgrep-config.js';
import { detectionConfirmationStep } from './02-detection-confirmation.js';
import { toolingInfrastructureStep } from './04-tooling-infrastructure.js';
import { workflowPrefsStep } from './06-workflow-prefs.js';
import { customBundlesStep } from './06_3-custom-bundles.js';
import { agentDiscoveryStep } from './06_5-agent-discovery.js';
import { generateFilesStep } from './07-generate-files.js';
import { verifyFilesStep } from './07_5-verify-files.js';
import { knowledgeAcquisitionStep } from './08-knowledge-acquisition.js';
import { knowledgeQaPrepStep } from './09-qa.js';
import { knowledgeQaResolveStep } from './09_2-qa-resolve.js';
import { skillGenerationStep } from './09_5-skill-generation.js';
import { skillVerificationStep } from './09_6-skill-verification.js';
import { ragSourceSelectionStep } from './09_7-rag-source-selection.js';
import { ragPopulateStep } from './10-rag-populate.js';
import { finalReviewStep } from './11-final-review.js';
import { postOnboardingStep } from './12-post-onboarding.js';

export {
  envDetectStep,
  ripgrepConfigStep,
  detectionConfirmationStep,
  toolingInfrastructureStep,
  workflowPrefsStep,
  customBundlesStep,
  agentDiscoveryStep,
  generateFilesStep,
  verifyFilesStep,
  knowledgeAcquisitionStep,
  knowledgeQaPrepStep,
  knowledgeQaResolveStep,
  skillGenerationStep,
  skillVerificationStep,
  ragSourceSelectionStep,
  ragPopulateStep,
  finalReviewStep,
  postOnboardingStep,
};

export function registerOnboardingSteps(registry: StepRegistry): void {
  registry.register(envDetectStep);
  registry.register(ripgrepConfigStep);
  registry.register(detectionConfirmationStep);
  registry.register(toolingInfrastructureStep);
  registry.register(workflowPrefsStep);
  registry.register(customBundlesStep);
  registry.register(agentDiscoveryStep);
  registry.register(generateFilesStep);
  registry.register(verifyFilesStep);
  registry.register(knowledgeAcquisitionStep);
  registry.register(knowledgeQaPrepStep);
  registry.register(knowledgeQaResolveStep);
  registry.register(skillGenerationStep);
  registry.register(skillVerificationStep);
  registry.register(ragSourceSelectionStep);
  registry.register(ragPopulateStep);
  registry.register(finalReviewStep);
  registry.register(postOnboardingStep);
}
