import type { StepRegistry } from '../registry.js';
import { registerEnvReplicateSteps } from './env-replicate/index.js';
import { registerOnboardingSteps } from './onboarding/index.js';
import { registerWorkflowSteps } from './workflow/index.js';

export { registerOnboardingSteps, registerEnvReplicateSteps, registerWorkflowSteps };

export function registerAllSteps(registry: StepRegistry): void {
  registerOnboardingSteps(registry);
  registerEnvReplicateSteps(registry);
  registerWorkflowSteps(registry);
}
