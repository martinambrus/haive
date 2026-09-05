import type { StepRegistry } from '../../registry.js';
import { planInputsStep } from './00-plan-inputs.js';
import { planBuildStep } from './01-plan-build.js';
import { planCoverageStep } from './02-plan-coverage.js';
import { planSequenceStep, standalonePlanSequenceStep } from './03-plan-sequence.js';
import { planChatStep } from './01-plan-chat.js';
import { planMergeStep } from './01-plan-merge.js';
import { advisoryResearchStep } from './01-advisory-research.js';
import { advisoryDecisionStep } from './02-advisory-decision.js';

/** Five workflow types share this directory because they share the patch
 *  contract and the mirror: plan_build (decompose), plan_sequence (put an
 *  existing plan in build order), plan_chat (converse), advisory (research a
 *  blocker, then let a HUMAN close it), and plan_merge (resolve a conflicted
 *  pull of the snapshot, as a conversation the user confirms). */
export function registerPlanSteps(registry: StepRegistry): void {
  // Deterministic, and first: it verifies the attached files and writes the
  // readable form of the ones the builder's agents could not open themselves.
  registry.register(planInputsStep);
  registry.register(planBuildStep);
  // Runs after the build; reports what it left undone and offers to redo it.
  registry.register(planCoverageStep);
  // Last in a build, because ordering a tree that is still growing would order
  // the wrong tree. The standalone twin is how an ALREADY-BUILT plan reaches it:
  // plan_build runs its steps once, so every plan made before this existed can
  // be ordered no other way.
  registry.register(planSequenceStep);
  registry.register(standalonePlanSequenceStep);
  registry.register(planChatStep);
  // Only reached when save/pull could not integrate the remote on their own —
  // a conflict outside the mirror's own two files.
  registry.register(planMergeStep);
  registry.register(advisoryResearchStep);
  registry.register(advisoryDecisionStep);
}
