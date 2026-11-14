import { PlanPatchError } from './errors.js';

export const PLAN_CONFLICT_ATTEMPTS = 3;

/** Only for an intent that can be rebuilt from a fresh read (a derived order,
 * completion mark or explicit unversioned delete). Never retry a stale agent or
 * canvas edit. The callback owns its whole transaction, so no connection stays
 * held between attempts. */
export async function retryPlanConflict<T>(
  applyFresh: () => Promise<T>,
  maxAttempts = PLAN_CONFLICT_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await applyFresh();
    } catch (err) {
      if (!(err instanceof PlanPatchError) || err.kind !== 'conflict' || attempt >= maxAttempts)
        throw err;
    }
  }
}
