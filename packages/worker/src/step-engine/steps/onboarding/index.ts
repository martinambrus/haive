import type { StepRegistry } from '../../registry.js';
import { makeModelHealthStep } from '../_model-health.js';
import { envDetectStep } from './01-env-detect.js';
import { ripgrepConfigStep } from './01_5-ripgrep-config.js';
import { detectionConfirmationStep } from './02-detection-confirmation.js';
import { toolingInfrastructureStep } from './04-tooling-infrastructure.js';
import { globalKbStep } from './04_5-global-kb.js';
import { customBundlesStep } from './06_3-custom-bundles.js';
import { agentDiscoveryStep } from './06_5-agent-discovery.js';
import { scopeSelectionStep } from './06_7-scope-selection.js';
import { generateFilesStep } from './07-generate-files.js';
import { verifyFilesStep } from './07_5-verify-files.js';
import { knowledgeAcquisitionStep } from './08-knowledge-acquisition.js';
import { knowledgeQaPrepStep } from './09-qa.js';
import { knowledgeQaSuggestionsStep } from './09_1-qa-suggestions.js';
import { knowledgeQaResolveStep } from './09_2-qa-resolve.js';
import { knowledgeQaReviewStep } from './09_3-qa-review.js';
import { skillGenerationStep } from './09_5-skill-generation.js';
import { skillRepairStep } from './09_5b-skill-repair.js';
import { skillVerificationStep } from './09_6-skill-verification.js';
import { globalKbMergeStep } from './09_6_4-global-kb-merge.js';
import { globalKbReviewStep } from './09_6_5-global-kb-review.js';
import { ragSourceSelectionStep } from './09_7-rag-source-selection.js';
import { ragPopulateStep } from './10-rag-populate.js';
import { finalReviewStep } from './11-final-review.js';
import { postOnboardingStep } from './12-post-onboarding.js';

export {
  envDetectStep,
  ripgrepConfigStep,
  detectionConfirmationStep,
  toolingInfrastructureStep,
  globalKbStep,
  customBundlesStep,
  agentDiscoveryStep,
  scopeSelectionStep,
  generateFilesStep,
  verifyFilesStep,
  knowledgeAcquisitionStep,
  knowledgeQaPrepStep,
  knowledgeQaSuggestionsStep,
  knowledgeQaResolveStep,
  knowledgeQaReviewStep,
  skillGenerationStep,
  skillRepairStep,
  skillVerificationStep,
  globalKbMergeStep,
  globalKbReviewStep,
  ragSourceSelectionStep,
  ragPopulateStep,
  finalReviewStep,
  postOnboardingStep,
};

export function registerOnboardingSteps(registry: StepRegistry): void {
  registry.register(makeModelHealthStep('onboarding'));
  registry.register(envDetectStep);
  registry.register(ripgrepConfigStep);
  registry.register(detectionConfirmationStep);
  registry.register(toolingInfrastructureStep);
  registry.register(globalKbStep);
  registry.register(customBundlesStep);
  registry.register(agentDiscoveryStep);
  registry.register(scopeSelectionStep);
  registry.register(generateFilesStep);
  registry.register(verifyFilesStep);
  registry.register(knowledgeAcquisitionStep);
  registry.register(knowledgeQaPrepStep);
  registry.register(knowledgeQaSuggestionsStep);
  registry.register(knowledgeQaResolveStep);
  registry.register(knowledgeQaReviewStep);
  registry.register(skillGenerationStep);
  registry.register(skillRepairStep);
  registry.register(skillVerificationStep);
  registry.register(globalKbMergeStep);
  registry.register(globalKbReviewStep);
  registry.register(ragSourceSelectionStep);
  registry.register(ragPopulateStep);
  registry.register(finalReviewStep);
  registry.register(postOnboardingStep);
}
