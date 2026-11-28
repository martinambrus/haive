import type { Database, RootClaimHandle } from '@haive/database';
import { withCheckoutMutation, type CheckoutAvailability } from '@haive/shared/checkout-access';
import { admitNewWork, assertNewWorkAllowed } from '../middleware/maintenance.js';

/**
 * A checkout mutation that starts new work: refused while the system drains or is in maintenance.
 *
 * Order is claim, then the fence, then the caller's locks. The precheck keeps a refused request's
 * claim out of the updater's recount. The fence runs in its own short transaction once the claim is
 * committed: an admission that wins the fence is already counted by an updater that runs after it,
 * and one that loses reads the new state and refuses. The shared fence lock is gone before `run`.
 */
export async function withAdmittedCheckoutMutation<T>(
  db: Database,
  repositoryId: string,
  userId: string,
  run: (owner: RootClaimHandle) => Promise<T>,
  availability: CheckoutAvailability = 'ready',
): Promise<T> {
  await assertNewWorkAllowed();
  return withCheckoutMutation(
    db,
    repositoryId,
    userId,
    async (owner) => {
      await db.transaction(async (tx) => {
        await admitNewWork(tx);
      });
      return run(owner);
    },
    availability,
  );
}
