import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import * as schema from './schema/index.js';
import type { Database } from './index.js';

// Transaction handle type (the callback arg of Database.transaction), so a caller inside its own
// transaction can use these too. Mirrors dag-reset.ts, the other helper api and worker both call.
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Who is rewriting the root. Carried only so a refusal can say what it is waiting for — nothing
 *  branches on it, because the exclusion is mutual either way. */
export type RootClaimKind = 'reset' | 'rebuild' | 'edit' | 'verify';

/**
 * How long a root claim is honoured WITHOUT a heartbeat before readers treat it as abandoned.
 *
 * The honest cost of a claim over a lock: an advisory lock dies with its connection, a row does
 * not, so a process killed mid-write leaves this set. Bounded rather than permanent, and visible
 * in one column — unlike `repositories.status`, whose `cloning` has no reconciler anywhere and
 * strands a repository for good.
 *
 * This is a LEASE, not a deadline on the work. A fixed expiry cannot tell a dead holder from a
 * slow one, and both exist here: `gitClone` has no timeout and `copyTree` is unbounded by
 * repository size, so a clone or a reset of a large tree can outlive any constant. Expiring one
 * of those re-admits exactly the concurrent `rm -rf` the claim exists to exclude — the race
 * returning at the fifteen-minute mark. `acquireRootClaim` therefore renews while it works, so
 * expiry means "the holder stopped renewing", which is what abandonment actually is.
 */
export const ROOT_CLAIM_STALE_MS = 15 * 60 * 1000;

/** How often a live holder refreshes its lease. A third of the window, so two renewals can be
 *  lost — a paused event loop, a slow query — before anyone else may take over. */
export const ROOT_CLAIM_RENEW_MS = Math.floor(ROOT_CLAIM_STALE_MS / 3);

/**
 * There is deliberately NO cap on how long a lease may keep renewing.
 *
 * One was tried and reverted, and the reasoning is worth keeping because it looks prudent. The
 * worry was a handle acquired and never released in a live process, renewing forever and blocking
 * the repository. But renewal is tied to `release()` for a reason: `gitClone` has no timeout and
 * `copyTree` is unbounded by repository size, so ANY elapsed-time deadline eventually expires a
 * holder that is still rewriting the tree — and then a second writer claims and replaces the same
 * tree concurrently, which is the exact catastrophe this whole mechanism exists to prevent.
 *
 * The two failures are not comparable. A cap trades a rare-but-silent DATA LOSS for a leak that
 * (a) requires a future caller to skip the `finally` every current one has, (b) is visible — the
 * repository refuses resets and names what holds it — and (c) ends at the next process restart,
 * because the renewal timer is `unref`ed and dies with the process. Bounding the wrong one of
 * those is worse than bounding neither.
 */

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
): Promise<boolean> {
  // Whether it actually CLEARED anything. A conditional release that matches no row returns
  // without error and looks exactly like success, which is how a holder can finish, report a
  // clean release, and leave the repository claimed for the rest of the window. The caller needs
  // to know so it can try the other stamp it may be holding.
  const cleared = await db
    .update(schema.repositories)
    .set({ rootClaimedAt: null, rootClaimKind: null })
    .where(
      claimedAt
        ? and(
            eq(schema.repositories.id, repositoryId),
            eq(schema.repositories.rootClaimedAt, claimedAt),
          )
        : eq(schema.repositories.id, repositoryId),
    )
    .returning({ id: schema.repositories.id });
  return cleared.length > 0;
}

/**
 * Refresh a lease we still hold. Returns the new stamp, or null if we no longer hold it.
 *
 * Conditional on the stamp we last wrote, so a holder whose lease already expired and was taken
 * over cannot claw it back — it learns it lost instead, which is what lets `acquireRootClaim`
 * stop renewing and stop pretending to protect anything.
 *
 * Exported so the renewal is testable without waiting out a real interval.
 */
export async function renewRootClaim(
  db: Database | DbHandle,
  repositoryId: string,
  previous: Date,
  /** The stamp to write. Passed in rather than generated here so the CALLER still knows what was
   *  attempted when this throws: a write that committed and then lost its acknowledgement leaves
   *  the row holding this value while the caller believes it holds `previous`, and every later
   *  conditional match — renewal and release alike — then silently misses. */
  next: Date = new Date(),
): Promise<Date | null> {
  const claimedAt = next;
  const renewed = await db
    .update(schema.repositories)
    .set({ rootClaimedAt: claimedAt })
    .where(
      and(
        eq(schema.repositories.id, repositoryId),
        eq(schema.repositories.rootClaimedAt, previous),
      ),
    )
    .returning({ id: schema.repositories.id });
  return renewed.length > 0 ? claimedAt : null;
}

/**
 * Which stamp the row carries after a renewal whose result never arrived: the one we attempted
 * (it committed), the one we held (it did not), or neither (someone took the lease over).
 *
 * A write that fails AFTER committing is indistinguishable from one that never ran, from the
 * client's side — so the only honest answer comes from reading the row back. Returning `held` on
 * a read that itself fails is deliberate: that is the behaviour before this existed, and a
 * transient database problem must not be escalated into "the lease is lost", which would stop
 * renewing a claim we may well still own.
 */
async function reconcileAmbiguousRenewal(
  db: Database | DbHandle,
  repositoryId: string,
  held: Date,
  attempted: Date,
): Promise<{ stamp: Date | null; proven: boolean }> {
  try {
    const rows = await db
      .select({ claimedAt: schema.repositories.rootClaimedAt })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .limit(1);
    const claimedAt = rows[0]?.claimedAt ?? null;
    if (claimedAt === null) return { stamp: null, proven: true };
    const stamp = claimedAt.getTime();
    if (stamp === attempted.getTime()) return { stamp: attempted, proven: true };
    if (stamp === held.getTime()) return { stamp: held, proven: true };
    // Some third value: the lease is someone else's now.
    return { stamp: null, proven: true };
  } catch {
    // Not an answer. The caller keeps working from `held` but must remember that the row may
    // instead hold what we tried to write.
    return { stamp: held, proven: false };
  }
}

/** A held claim. `release` is idempotent and safe to call after the lease was lost. */
export interface RootClaimHandle {
  release(): Promise<void>;
  /**
   * Did another writer take this lease over while we held it?
   *
   * Only reachable when renewals fail for a FULL stale window while the database stays healthy
   * enough for someone else's takeover CAS — a partition that reaches us and not them, or an
   * event loop blocked for fifteen minutes. It means two writers touched one tree.
   *
   * Observable rather than fatal, deliberately. The destructive work cannot be preempted: there
   * is no cancelling a `copyTree` or an `rm -rf` mid-call, and THROWING afterwards would hand the
   * job back to BullMQ's `attempts: 3`, which re-runs the clone and puts a third writer on the
   * same tree. What is left is to say so, loudly, at the point where a caller would otherwise
   * report a clean result.
   */
  lost(): boolean;
}

/**
 * Take a root claim and KEEP it for as long as the caller works, then release it.
 *
 * This is the form every caller should use. The bare `claimRepositoryRoot` writes one stamp and
 * walks away, which is fine only for work that certainly finishes inside
 * `ROOT_CLAIM_STALE_MS` — and neither a clone nor a reset of a large repository certainly does.
 *
 * The renewal timer is `unref`ed, so a held claim never keeps a process alive on its own: if
 * everything else has finished, the process exits and the lease expires naturally, which is the
 * correct reading of a holder that is gone.
 *
 * Takes a `Database` and NOT a transaction handle, unlike everything else in this module. A lease
 * outlives any one statement by design, so renewals issued on a handle whose transaction has
 * ended would fail — silently, since a failed renewal is treated as a transient — and the lease
 * would lapse in the middle of the work it is protecting. Refusing the type is what stops that
 * being a comment somebody has to read.
 */
export async function acquireRootClaim(
  db: Database,
  repositoryId: string,
  kind: RootClaimKind,
  userId?: string,
): Promise<RootClaimHandle | null> {
  const first = await claimRepositoryRoot(db, repositoryId, kind, userId);
  if (first === null) return null;

  let current: Date | null = first.claimedAt;

  // Set where the loss is LEARNED, not where it is noticed. Deriving it from `current === null` at
  // release time would be wrong in both directions: `lost()` would answer false for a lease
  // already known to be gone, and a second `release()` — which the interface promises is safe —
  // would find no stamp and report a takeover that never happened.
  let lost = false;
  /** The stamp an ambiguous renewal may have written, when the read-back could not confirm it. */
  let unproven: Date | null = null;

  // The in-flight renewal, so `release` can WAIT for it. Without that, a release firing while a
  // renewal is pending captures the old stamp, its conditional UPDATE matches nothing, and it
  // returns successfully having cleared NOTHING — leaving the row claimed for a full window after
  // the writer finished, refusing every refresh, reset and knowledge-file save in between.
  let renewing: Promise<void> | null = null;

  const renewOnce = async (): Promise<void> => {
    if (current === null) return;
    const held = current;
    const attempted = new Date();
    let next = await renewRootClaim(db, repositoryId, held, attempted)
      .then((stamp) => ({ stamp, proven: true }))
      .catch(() =>
        // AMBIGUOUS, not failed. The UPDATE may have committed and lost only its
        // acknowledgement, in which case the row now holds `attempted` while we still believe we
        // hold `held` — and then every later conditional match misses: the release clears
        // nothing, the next renewal reports the lease lost, and the repository stays claimed for
        // the rest of the window with nobody working on it. Ask the row which it carries.
        reconcileAmbiguousRenewal(db, repositoryId, held, attempted),
      );
    // An UNPROVEN answer is a guess, not a reading: the reconciliation read failed too, so the
    // row may well hold `attempted`. Carrying it matters because the next healthy renewal would
    // otherwise match nothing and report a takeover that never happened — renewal stops, the
    // claim is never cleared, and after the stale window a second writer enters the tree this
    // one is still rewriting, which is the catastrophe the whole mechanism exists to prevent.
    if (!next.proven) unproven = attempted;
    else if (next.stamp !== null) unproven = null;
    // A miss while an unproven stamp is outstanding is not yet a takeover: try renewing FROM the
    // stamp that write may have left behind before concluding anything.
    if (next.stamp === null && unproven !== null) {
      const recovered = await renewRootClaim(db, repositoryId, unproven, new Date()).catch(
        () => null,
      );
      if (recovered !== null) {
        next = { stamp: recovered, proven: true };
        unproven = null;
      }
    }
    // null means the lease was taken over while we worked. Stop renewing and stop releasing:
    // the claim on the row is someone else's now, and clearing it would strip their protection.
    current = next.stamp;
    if (current === null) {
      lost = true;
      clearInterval(timer);
    }
  };

  const timer = setInterval(() => {
    // Never overlap two renewals: the second would race the first on the same stamp.
    if (renewing !== null) return;
    renewing = renewOnce().finally(() => {
      renewing = null;
    });
  }, ROOT_CLAIM_RENEW_MS);
  timer.unref?.();

  return {
    lost: () => lost,
    async release() {
      clearInterval(timer);
      // Let a pending renewal land first, so the stamp below is the one actually on the row.
      if (renewing !== null) await renewing.catch(() => undefined);
      if (current === null) return;
      const cleared = await releaseRepositoryRoot(db, repositoryId, current);
      // `current` may be a GUESS: when a renewal's acknowledgement and its read-back both failed,
      // we kept the old stamp while the row may hold the one that write left behind. A release
      // matching nothing is exactly that case, and it is the COMMON one — a job that finishes
      // right after such a renewal would otherwise report a clean release and leave the
      // repository claimed for the rest of the window. The renewal path already retries from the
      // unproven stamp; this is the same rule on the path that actually ends the work.
      if (!cleared && unproven !== null) {
        await releaseRepositoryRoot(db, repositoryId, unproven);
        unproven = null;
      }
      current = null;
    },
  };
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
  if (kind === 'rebuild') {
    return 'This repository is being rebuilt from its source. Wait for that to finish and try again.';
  }
  if (kind === 'edit') {
    return 'A knowledge file in this repository is being saved. Try again in a moment.';
  }
  if (kind === 'verify') {
    return 'This repository is being checked. Try again in a moment.';
  }
  // Also the fallback for a claim written before `root_claim_kind` existed: a refusal still has
  // to say something true, and "reset" is the one a person can act on.
  return 'This repository is being reset. Wait for that to finish and try again.';
}
