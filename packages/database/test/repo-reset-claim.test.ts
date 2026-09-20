import { describe, expect, it } from 'vitest';
import { RESET_CLAIM_STALE_MS, isResetClaimLive } from '../src/repo-reset-claim.js';

/**
 * The one part of the reset claim that is not SQL, and the one every reader shares.
 *
 * Four call sites refuse a write on this answer — `refresh-tree`, the knowledge-file editor, and
 * the three repo-queue handlers through `hasLiveResetClaim`. They must agree without a round
 * trip, which is why the rule is a pure function here rather than a predicate each of them
 * rebuilds. The CAS itself is SQL and is covered by `smoke:reset-claim`.
 */
describe('isResetClaimLive', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('treats no claim as no refusal', () => {
    expect(isResetClaimLive(null, now)).toBe(false);
    expect(isResetClaimLive(undefined, now)).toBe(false);
  });

  it('honours a claim taken just now', () => {
    expect(isResetClaimLive(now, now)).toBe(true);
    expect(isResetClaimLive(new Date(now.getTime() - 1_000), now)).toBe(true);
  });

  it('stops honouring one older than the staleness window', () => {
    // The honest cost of a row over a lock: an API killed mid-walk leaves this set, so it has to
    // expire. Expiring EARLY is the bad direction — it re-admits the `rm -rf` the claim exists to
    // exclude — which is why the window is generous rather than tight.
    const abandoned = new Date(now.getTime() - RESET_CLAIM_STALE_MS - 1);
    expect(isResetClaimLive(abandoned, now)).toBe(false);
  });

  it('honours one exactly at the boundary, so the window is closed at its far end only', () => {
    const edge = new Date(now.getTime() - RESET_CLAIM_STALE_MS + 1);
    expect(isResetClaimLive(edge, now)).toBe(true);
  });

  it('honours a claim whose clock runs ahead of the reader', () => {
    // Two processes, two clocks. A claim stamped slightly in the future must not read as
    // abandoned — that would admit a writer while the reset is actively walking.
    expect(isResetClaimLive(new Date(now.getTime() + 30_000), now)).toBe(true);
  });
});
