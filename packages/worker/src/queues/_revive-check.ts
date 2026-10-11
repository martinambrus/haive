import type { DbTx } from '@haive/database';
import { reviveRefusal } from '@haive/shared/onboarding-admission';

export interface ReviveRefused {
  reason: string;
  otherTaskId?: string;
}

/** The api's `refuseReviveBesideLive` for the worker: the creation's checks under the repository
 *  lock, then, for an upgrade or rollback, the reset admission on the locked row. Call it first in
 *  the transaction that revives a failed task; null when the revival may go ahead. */
export async function refuseRevive(tx: DbTx, taskId: string): Promise<ReviveRefused | null> {
  const verdict = await reviveRefusal(tx, taskId);
  if (!verdict) return null;
  const why = 'refusal' in verdict ? verdict.refusal : verdict.admission;
  return 'taskId' in why ? { reason: why.reason, otherTaskId: why.taskId } : { reason: why.reason };
}
