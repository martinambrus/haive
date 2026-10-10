import { LIVE_TASK_STATUSES, type DbTx } from '@haive/database';
import { loadOnboardingTaskFacts, type UpgradeAdmission } from '@haive/shared/onboarding-admission';
import type { Database } from '../db.js';

/**
 * Task statuses an onboarding run can hold while it is still going to do more work.
 *
 * The complement of the terminal three (`completed` / `failed` / `cancelled`), written out
 * rather than derived so a new status added to the enum has to be classified here on purpose.
 * `waiting_user` is in the LIVE set deliberately: a run parked on a form is the normal state
 * of onboarding for most of its life, and it is exactly the state the repo was misread in.
 */
export { LIVE_TASK_STATUSES };

export {
  checkOnboardingMarkers,
  hasArtifactsSinceReset,
  hasCompletedSinceReset,
  loadNewestLiveArtifactAt,
  loadOnboardingTaskFacts,
  NO_ONBOARDING_TASKS,
  ONBOARDING_MARKERS,
  renderContextAdmitsUpgrade,
  resolveOnboardingVerdict,
  upgradeAdmission,
  type OnboardingTaskFacts,
  type OnboardingVerdict,
  type RepositoryForUpgrade,
  type UpgradeAdmission,
} from '@haive/shared/onboarding-admission';

/** The newest live onboarding task of the repository, or null. */
export async function liveOnboardingTaskId(
  db: Database | DbTx,
  userId: string,
  repositoryId: string,
): Promise<string | null> {
  const facts = (await loadOnboardingTaskFacts(db, userId, [repositoryId])).get(repositoryId);
  return facts?.liveTaskId ?? null;
}

/** The 409 text for a refused admission; `action` names what was refused. */
export function upgradeRefusalMessage(
  refusal: Exclude<UpgradeAdmission, { admitted: true }>,
  action: 'upgraded' | 'rolled back',
): string {
  if (refusal.reason === 'live-onboarding') {
    return `Onboarding is still running for this repository (task ${refusal.taskId}), so it cannot be ${action} yet`;
  }
  return refusal.reason === 'reset'
    ? `This repository was reset and no onboarding has finished since, so it cannot be ${action}`
    : `No completed onboarding found for this repository, so it cannot be ${action}`;
}
