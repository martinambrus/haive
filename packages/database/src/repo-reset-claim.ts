import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import * as schema from './schema/index.js';
import type { Database } from './index.js';

// Transaction handle type (the callback arg of Database.transaction), so a caller inside its own
// transaction can use these too. Mirrors dag-reset.ts, the other helper api and worker both call.
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * How long a reset claim is honoured before readers treat it as abandoned.
 *
 * The honest cost of a claim over a lock: an advisory lock dies with its connection, a row does
 * not, so an API killed mid-walk leaves this set. Bounded rather than permanent, and visible in
 * one column — unlike the pool deadlock the lock version would have produced.
 *
 * Generous on purpose. It only has to exceed a filesystem walk, and expiring early is the bad
 * direction: it re-admits exactly the `rm -rf` this exists to exclude, while expiring late merely
 * delays a retry by minutes on a repository whose API process has already crashed.
 */
export const RESET_CLAIM_STALE_MS = 15 * 60 * 1000;

/** Is this claim still one a writer must refuse for? Pure, so every reader agrees without a
 *  round trip and the rule is unit-testable. */
export function isResetClaimLive(claimedAt: Date | null | undefined, now = new Date()): boolean {
  if (!claimedAt) return false;
  return now.getTime() - claimedAt.getTime() < RESET_CLAIM_STALE_MS;
}

/**
 * Claim a repository for an onboarding-artifact reset. `false` means someone already holds it.
 *
 * One atomic UPDATE, which is what makes it a claim rather than the read the reset's existing
 * live-task guard is: nothing can slip between the test and the write. A stale claim is taken
 * over rather than waited on, so an API that died mid-walk costs one window and not the feature.
 *
 * `userId` is part of the predicate and not decoration — the repository writes around it key on
 * the URL id alone, and a claim is the one that would otherwise let any authenticated caller
 * stall another tenant's repository.
 */
export async function claimRepositoryForReset(
  db: Database | DbHandle,
  repositoryId: string,
  userId: string,
): Promise<boolean> {
  const claimed = await db
    .update(schema.repositories)
    .set({ onboardingResetClaimedAt: new Date() })
    .where(
      and(
        eq(schema.repositories.id, repositoryId),
        eq(schema.repositories.userId, userId),
        or(
          isNull(schema.repositories.onboardingResetClaimedAt),
          lt(
            schema.repositories.onboardingResetClaimedAt,
            sql`now() - ${`${RESET_CLAIM_STALE_MS} milliseconds`}::interval`,
          ),
        ),
      ),
    )
    .returning({ id: schema.repositories.id });
  return claimed.length > 0;
}

/** Release the claim. Runs on every exit path, including the failure ones — a reset that threw
 *  has stopped touching the tree just as surely as one that finished. */
export async function releaseRepositoryResetClaim(
  db: Database | DbHandle,
  repositoryId: string,
): Promise<void> {
  await db
    .update(schema.repositories)
    .set({ onboardingResetClaimedAt: null })
    .where(eq(schema.repositories.id, repositoryId));
}

/** The claim as a writer sees it: live, and therefore a refusal. Reads the row itself so callers
 *  that already hold no repository row do not have to fetch one. */
export async function hasLiveResetClaim(
  db: Database | DbHandle,
  repositoryId: string,
): Promise<boolean> {
  const rows = await db
    .select({ claimedAt: schema.repositories.onboardingResetClaimedAt })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  return isResetClaimLive(rows[0]?.claimedAt ?? null);
}
