import { describe, expect, it } from 'vitest';
import {
  ROOT_CLAIM_MAX_MS,
  ROOT_CLAIM_RENEW_MS,
  ROOT_CLAIM_STALE_MS,
  isRootClaimLive,
  rootClaimRefusal,
} from '../src/repo-root-claim.js';

/**
 * The one part of the root claim that is not SQL, and the one every reader shares.
 *
 * Four call sites refuse a write on this answer — `refresh-tree`, the knowledge-file editor, and
 * the three repo-queue handlers through the claim they take themselves. They must agree without a
 * round trip, which is why the rule is a pure function rather than a predicate each of them
 * rebuilds. The CAS itself is SQL and is covered by `smoke:reset-claim`.
 */
describe('isRootClaimLive', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('treats no claim as no refusal', () => {
    expect(isRootClaimLive(null, now)).toBe(false);
    expect(isRootClaimLive(undefined, now)).toBe(false);
  });

  it('honours a claim taken just now', () => {
    expect(isRootClaimLive(now, now)).toBe(true);
    expect(isRootClaimLive(new Date(now.getTime() - 1_000), now)).toBe(true);
  });

  it('stops honouring one older than the staleness window', () => {
    // The honest cost of a row over a lock: a writer killed mid-job leaves this set, so it has to
    // expire. Expiring EARLY is the bad direction — it re-admits the concurrent `rm -rf` the claim
    // exists to exclude — which is why the window is generous rather than tight.
    expect(isRootClaimLive(new Date(now.getTime() - ROOT_CLAIM_STALE_MS - 1), now)).toBe(false);
  });

  it('honours one exactly inside the boundary, so the window closes at its far end only', () => {
    expect(isRootClaimLive(new Date(now.getTime() - ROOT_CLAIM_STALE_MS + 1), now)).toBe(true);
  });

  it('honours a claim whose clock runs ahead of the reader', () => {
    // Two processes, two clocks. A claim stamped slightly in the future must not read as
    // abandoned — that would admit a writer while the holder is actively rewriting the tree.
    expect(isRootClaimLive(new Date(now.getTime() + 30_000), now)).toBe(true);
  });
});

describe('the lease constants', () => {
  it('renews often enough to survive losing a renewal or two', () => {
    // A single missed renewal must not hand the repository to another destructive writer while
    // the holder is still walking it; at a third of the window, two can be lost first.
    expect(ROOT_CLAIM_RENEW_MS).toBeLessThan(ROOT_CLAIM_STALE_MS / 2);
    expect(ROOT_CLAIM_RENEW_MS).toBeGreaterThan(0);
  });

  it('gives up renewing well after the slowest legitimate holder', () => {
    // Renewal introduces a failure the fixed expiry could not have — a handle never released, in
    // a process that stays alive, renewing forever and blocking the repository PERMANENTLY. The
    // cap makes that bounded. It has to sit far above the window it is bounding, or a normal
    // holder would hit it.
    expect(ROOT_CLAIM_MAX_MS).toBeGreaterThan(ROOT_CLAIM_STALE_MS * 4);
  });
});

describe('rootClaimRefusal', () => {
  it('names what the caller is waiting for', () => {
    expect(rootClaimRefusal('rebuild')).toContain('rebuilt');
    expect(rootClaimRefusal('reset')).toContain('reset');
  });

  it('falls back to the reset wording when the kind was never recorded', () => {
    // A row claimed before `root_claim_kind` existed, or one written by an older build. The
    // refusal still has to say something true, and "reset" is the claim a user can act on.
    expect(rootClaimRefusal(null)).toContain('reset');
  });
});
