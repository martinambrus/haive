import type { StepRegistry } from '../../registry.js';
import { bundleResyncStep } from './00-bundle-resync.js';
import { upgradePlanStep } from './01-upgrade-plan.js';
import { upgradeApplyStep } from './02-upgrade-apply.js';
import { upgradeCommitStep } from './03-upgrade-commit.js';
import { upgradeRollbackStep } from './04-upgrade-rollback.js';

export {
  bundleResyncStep,
  upgradePlanStep,
  upgradeApplyStep,
  upgradeCommitStep,
  upgradeRollbackStep,
};
export type {
  UpgradePlanDetect,
  UpgradePlanEntry,
  UpgradePlanOutput,
  UpgradePlanBucket,
} from './01-upgrade-plan.js';

export function registerOnboardingUpgradeSteps(registry: StepRegistry): void {
  registry.register(bundleResyncStep);
  registry.register(upgradePlanStep);
  registry.register(upgradeApplyStep);
  registry.register(upgradeCommitStep);
  registry.register(upgradeRollbackStep);
}
