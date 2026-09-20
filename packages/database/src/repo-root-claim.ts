import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import * as schema from './schema/index.js';
import type { Database } from './index.js';

// Transaction handle type (the callback arg of Database.transaction), so a caller inside its own
// transaction can use these too. Mirrors dag-reset.ts, the other helper api and worker both call.
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Who is rewriting the root. Carried only so a refusal can say what it is waiting for — nothing
 *  branches on it, because the exclusion is mutual either way. */
export type RootClaimKind = 'reset' | 'rebuild';

/**
 * How long a root claim is honoured before readers treat it as abandoned.
 *
 * The honest cost of a claim over a lock: an advisory lock dies with its connection, a row does
 * not, so a process killed mid-write leaves this set. Bounded rather than permanent, and visible
 * in one column — unlike `repositories.status`, whose `cloning` has no reconciler anywhere and
 * strands a repository for good.
 *
 * Generous on purpose. It only has to exceed a filesystem walk or a tree copy, and expiring early
 * is the bad direction: it re-admits exactly the concurrent `rm -rf` this exists to exclude, while
 * expiring late merely delays a retry on a repository whose writer has already died.
 */
export const ROOT_CLAIM_STALE_MS = 15 * 60 * 1000;

/** Is this claim still one another writer must refuse for? Pure, so every reader agrees without a
 *  round trip and the rule is unit-testable. */
export function isRootClaimLive(claimedAt: Date | null | undefined, now = new Date()): boolean {
  if (!claimedAt) return false;
  return now.getTime() - claimedAt.getTime() < ROOT_CLAIM_STALE_MS;
}

export interface RootClaim {
  /** The stamp this claim wrote. Hand it back to `releaseRepositoryRoot` so an expired holder
   *  cannot release the claim that replaced it. */
  claimedAt: Date;
}

/**
 * Claim a repository's ROOT for exclusive rewriting. `null` means someone else holds it.
 *
 * RECIPROCAL, and that is the whole point: the onboarding-artifact reset and the repo-queue
 * handlers that `rm -rf` the root take the same claim, so whichever arrives second refuses. A
 * one-directional check — the rebuild reading a flag the reset sets — leaves the window where the
 * rebuild has already passed its check and the reset claims before `rm(dest)` runs, and both then
 * walk the same tree.
 *
 * One atomic UPDATE, which is what makes it a claim rather than a read: nothing can slip between
 * the test and the write. A stale claim is taken over rather than waited on, so a writer that died
 * mid-job costs one window and not the feature.
 *
 * `userId` is checked when given. The API routes pass it — the repository writes around them key
 * on a URL id alone, and a claim is the one that would otherwise let any authenticated caller
 * stall another tenant's repository. Queue handlers omit it: their payload is Haive's own.
 */
export async function claimRepositoryRoot(
  db: Database | DbHandle,
  repositoryId: string,
  kind: RootClaimKind,
  userId?: string,
): Promise<RootClaim | null> {
  const claimedAt = new Date();
  const claimed = await db
    .update(schema.repositories)
    .set({ rootClaimedAt: claimedAt, rootClaimKind: kind })
    .where(
      and(
        eq(schema.repositories.id, repositoryId),
        ...(userId ? [eq(schema.repositories.userId, userId)] : []),
        or(
          isNull(schema.repositories.rootClaimedAt),
          lt(
            schema.repositories.rootClaimedAt,
            sql`now() - ${`${ROOT_CLAIM_STALE_MS} milliseconds`}::interval`,
          ),
        ),
      ),
    )
    .returning({ id: schema.repositories.id });
  return claimed.length > 0 ? { claimedAt } : null;
}

/**
 * Release a claim.
 *
 * `claimedAt` makes it conditional, and passing it matters: a writer that outran
 * `ROOT_CLAIM_STALE_MS` has already had its claim taken over, and an unconditional clear would
 * strip the protection from the job that took over — silently, and exactly on the slowest trees,
 * which are the ones that reach the window in the first place.
 */
export async function releaseRepositoryRoot(
  db: Database | DbHandle,
  repositoryId: string,
  claimedAt?: Date,
): Promise<void> {
  await db
    .update(schema.repositories)
    .set({ rootClaimedAt: null, rootClaimKind: null })
    .where(
      claimedAt
        ? and(
            eq(schema.repositories.id, repositoryId),
            eq(schema.repositories.rootClaimedAt, claimedAt),
          )
        : eq(schema.repositories.id, repositoryId),
    );
}

/** The live claim on this repository, or null. Readers that only need to refuse use this; the
 *  kind is for the message they show. */
export async function readLiveRootClaim(
  db: Database | DbHandle,
  repositoryId: string,
): Promise<{ kind: RootClaimKind | null; claimedAt: Date } | null> {
  const rows = await db
    .select({
      claimedAt: schema.repositories.rootClaimedAt,
      kind: schema.repositories.rootClaimKind,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row?.claimedAt || !isRootClaimLive(row.claimedAt)) return null;
  return { kind: (row.kind as RootClaimKind | null) ?? null, claimedAt: row.claimedAt };
}

/** What a refusal should say. One place, so the reset route, the refresh route, the knowledge-file
 *  editor and the queue handlers cannot describe the same state three different ways. */
export function rootClaimRefusal(kind: RootClaimKind | null): string {
  return kind === 'rebuild'
    ? 'This repository is being rebuilt from its source. Wait for that to finish and try again.'
    : 'This repository is being reset. Wait for that to finish and try again.';
}
