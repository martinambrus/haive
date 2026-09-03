import type { StepRegistry } from '../../registry.js';
import { planInputsStep } from './00-plan-inputs.js';
import { planBuildStep } from './01-plan-build.js';
import { planCoverageStep } from './02-plan-coverage.js';
import { planChatStep } from './01-plan-chat.js';
import { advisoryResearchStep } from './01-advisory-research.js';
import { advisoryDecisionStep } from './02-advisory-decision.js';

/** Three workflow types share this directory because they share the patch
 *  contract and the mirror: plan_build (decompose), plan_chat (converse), and
 *  advisory (research a blocker, then let a HUMAN close it). */
export function registerPlanSteps(registry: StepRegistry): void {
  // Deterministic, and first: it verifies the attached files and writes the
  // readable form of the ones the builder's agents could not open themselves.
  registry.register(planInputsStep);
  registry.register(planBuildStep);
  // Runs after the build; reports what it left undone and offers to redo it.
  registry.register(planCoverageStep);
  registry.register(planChatStep);
  registry.register(advisoryResearchStep);
  registry.register(advisoryDecisionStep);
}
