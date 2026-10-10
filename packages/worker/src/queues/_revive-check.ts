import { checkRevive, type DbTx } from '@haive/database';
import { upgradeAdmission } from '@haive/shared/onboarding-admission';

export interface ReviveRefused {
  reason: string;
  otherTaskId?: string;
}

/** The api's `refuseReviveBesideLive` for the worker: the creation's checks under the repository
 *  lock, then, for an upgrade or rollback, the reset admission on the locked row. Call it first in
 *  the transaction that revives a failed task; null when the revival may go ahead. */
export async function refuseRevive(tx: DbTx, taskId: string): Promise<ReviveRefused | null> {
  const check = await checkRevive(tx, taskId);
  if (!check) return null;
  if (check.refusal) {
    const { reason } = check.refusal;
    return 'taskId' in check.refusal ? { reason, otherTaskId: check.refusal.taskId } : { reason };
  }
  if (check.task.type !== 'onboarding_upgrade') return null;
  const admission = await upgradeAdmission(tx, check.task.userId, check.repo);
  if (admission.admitted) return null;
  return admission.reason === 'live-onboarding'
    ? { reason: admission.reason, otherTaskId: admission.taskId }
    : { reason: admission.reason };
}
