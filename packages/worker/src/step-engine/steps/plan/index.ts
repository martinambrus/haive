import type { StepRegistry } from '../../registry.js';
import { planBuildStep } from './01-plan-build.js';
import { planChatStep } from './01-plan-chat.js';
import { advisoryResearchStep } from './01-advisory-research.js';
import { advisoryDecisionStep } from './02-advisory-decision.js';

/** Three workflow types share this directory because they share the patch
 *  contract and the mirror: plan_build (decompose), plan_chat (converse), and
 *  advisory (research a blocker, then let a HUMAN close it). */
export function registerPlanSteps(registry: StepRegistry): void {
  registry.register(planBuildStep);
  registry.register(planChatStep);
  registry.register(advisoryResearchStep);
  registry.register(advisoryDecisionStep);
}
