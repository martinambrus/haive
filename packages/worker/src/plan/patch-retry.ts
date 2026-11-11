import { applyPlanPatch, PlanPatchError } from '@haive/shared/plan';

const BACKOFF_MS = [1_000, 2_000, 3_000, 4_000];

/** Retry the same intent, never another planner turn. Wrap the WHOLE transaction
 * that claims a mining reply, so backoff holds neither its row nor a connection.
 * Five bounded lock attempts plus ten seconds of backoff cost about 15 seconds.
 * Other refusals (especially a stale version) must still reach the caller.
 */
export async function retryPlanPatch<T>(apply: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await apply();
    } catch (err) {
      if (!(err instanceof PlanPatchError) || err.kind !== 'busy') throw err;
      const delay = BACKOFF_MS[attempt];
      if (delay === undefined) {
        throw new PlanPatchError('busy', 'The plan stayed busy. Try again.');
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** For pool-backed, non-mining writes. A claimed reply uses retryPlanPatch around
 * its owning transaction instead, so no mining row stays locked during backoff. */
export const applyPlanPatchWithRetry = (...args: Parameters<typeof applyPlanPatch>) =>
  retryPlanPatch(() => applyPlanPatch(...args));
