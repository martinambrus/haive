import { PROVIDER_SENSITIVE_STEP_IDS } from '@haive/shared';
import type { StepRegistry } from '../registry.js';
import { registerEnvReplicateSteps } from './env-replicate/index.js';
import { registerOnboardingSteps } from './onboarding/index.js';
import { registerOnboardingUpgradeSteps } from './onboarding-upgrade/index.js';
import { registerWorkflowSteps } from './workflow/index.js';

export {
  registerOnboardingSteps,
  registerEnvReplicateSteps,
  registerWorkflowSteps,
  registerOnboardingUpgradeSteps,
};

export function registerAllSteps(registry: StepRegistry): void {
  registerOnboardingSteps(registry);
  registerEnvReplicateSteps(registry);
  registerWorkflowSteps(registry);
  registerOnboardingUpgradeSteps(registry);
  assertProviderSensitiveListInSync(registry);
}

/** Startup sanity check: the PROVIDER_SENSITIVE_STEP_IDS constant in
 *  @haive/shared is read by the api package to know which task_steps rows
 *  to invalidate on provider change. It must match the set of step
 *  definitions with `metadata.providerSensitive === true`. Drift would
 *  silently cause stale detect output or over-invalidation. */
function assertProviderSensitiveListInSync(registry: StepRegistry): void {
  const actual = new Set(
    registry
      .all()
      .filter((d) => d.metadata.providerSensitive === true)
      .map((d) => d.metadata.id),
  );
  const declared = new Set(PROVIDER_SENSITIVE_STEP_IDS);
  const missing = [...actual].filter((id) => !declared.has(id));
  const extra = [...declared].filter((id) => !actual.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `PROVIDER_SENSITIVE_STEP_IDS out of sync with StepDefinition.metadata.providerSensitive — missing in shared: [${missing.join(', ')}], extra in shared: [${extra.join(', ')}]`,
    );
  }
}
