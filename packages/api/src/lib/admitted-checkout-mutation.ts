import {
  acquireRootClaim,
  type Database,
  type RootClaimHandle,
  type RootClaimKind,
} from '@haive/database';
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
      await admitUnderFence(db);
      return run(owner);
    },
    availability,
  );
}

/** The fence in its own short transaction: its shared lock is released before the work starts. */
export async function admitUnderFence(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await admitNewWork(tx);
  });
}

/**
 * The same admission for a request that holds its own claim kind. Null as `acquireRootClaim`
 * answers it (someone else holds the root); the caller releases the handle. A refusal throws
 * `NewWorkRefused` (503) or the 409 busy, with the claim already released.
 */
export async function acquireAdmittedRootClaim(
  db: Database,
  repositoryId: string,
  kind: RootClaimKind,
  userId?: string,
): Promise<RootClaimHandle | null> {
  await assertNewWorkAllowed();
  const claim = await acquireRootClaim(db, repositoryId, kind, userId);
  if (claim === null) return null;
  try {
    await admitUnderFence(db);
  } catch (err) {
    await claim.release().catch(() => undefined);
    throw err;
  }
  return claim;
}
