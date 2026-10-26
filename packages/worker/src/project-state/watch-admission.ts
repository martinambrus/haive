import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { isRootClaimLive, schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import { checkoutMatches, type NamedCheckout } from '../repo/checkout-head.js';
import { gitOperationInProgress } from '../repo/git-operation.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Caller holds its domain lock. Keep the repository row through the import so a new root claim
 * waits, and consult structural task state rather than cancellation diagnostics or retry counts. */
export async function admitWatchedCheckout(
  tx: Tx,
  repositoryId: string,
  repoPath: string,
  expected: NamedCheckout,
): Promise<boolean> {
  const [repo] = await tx
    .select({
      status: schema.repositories.status,
      claimedAt: schema.repositories.rootClaimedAt,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .for('update');
  if (!repo || repo.status !== 'ready' || isRootClaimLive(repo.claimedAt)) return false;
  const held = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        isNull(schema.tasks.deadAt),
        or(
          inArray(schema.tasks.type, ['onboarding', 'onboarding_upgrade']),
          isNull(schema.tasks.worktreePath),
        ),
      ),
    )
    .limit(1);
  return (
    held.length === 0 &&
    !(await gitOperationInProgress(repoPath)) &&
    (await checkoutMatches(repoPath, expected))
  );
}
