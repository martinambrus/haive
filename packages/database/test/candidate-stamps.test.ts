import { describe, expect, it } from 'vitest';
import { CANDIDATE_STAMP_CAP, createCandidateStamps } from '../src/repo-root-claim.js';

/**
 * The stamps a claim row might carry after writes whose outcome could not be established.
 *
 * Extracted from the lease precisely so this can be asserted directly: the property that matters
 * is structural, and while it lived inside `acquireRootClaim` it could only be reached by driving
 * a fake database through several renewal cycles on fake timers — which is how it came to be
 * written as a single slot twice, each time discarding a stamp the row may actually have held.
 */

const at = (ms: number): Date => new Date(1_700_000_000_000 + ms);

describe('createCandidateStamps', () => {
  it('ADDS rather than replaces, which is the whole point', () => {
    // Ambiguity composes. A renewal can commit stamp B without an acknowledgement while a later
    // recovery from B throws BEFORE committing — the row then still holds B. Replacing B with the
    // newer attempt discards the only correct value, both candidates miss on the next tick, and
    // the holder declares a takeover that never happened while its clone is still running.
    const c = createCandidateStamps();
    c.remember(at(1));
    c.remember(at(2));
    expect(c.list()).toEqual([at(1), at(2)]);
  });

  it('ignores a stamp it already holds, by value rather than identity', () => {
    const c = createCandidateStamps();
    c.remember(at(1));
    c.remember(new Date(at(1).getTime()));
    expect(c.size()).toBe(1);
  });

  it('drops one proven NOT to be the row value, and keeps the rest', () => {
    // A proven miss excludes that candidate specifically. Only once every one is excluded is the
    // lease really someone else's.
    const c = createCandidateStamps();
    c.remember(at(1));
    c.remember(at(2));
    c.drop(at(1));
    expect(c.list()).toEqual([at(2)]);
    // Dropping something never held is a no-op, not a corruption.
    c.drop(at(99));
    expect(c.list()).toEqual([at(2)]);
  });

  it('clears entirely on a proven reading', () => {
    const c = createCandidateStamps();
    c.remember(at(1));
    c.remember(at(2));
    c.clear();
    expect(c.size()).toBe(0);
  });

  it('is bounded, because a long outage must not accumulate forever', () => {
    // Each entry costs a renewal cycle whose read ALSO failed, so reaching the cap means the
    // database has been unreadable for longer than the stale window — where a takeover is
    // legitimate anyway. The oldest goes first.
    const c = createCandidateStamps(3);
    for (let i = 1; i <= 5; i += 1) c.remember(at(i));
    expect(c.size()).toBe(3);
    expect(c.list()).toEqual([at(3), at(4), at(5)]);
  });

  it('hands back a copy, so a caller iterating it cannot be surprised mid-loop', () => {
    // The renewal loop drops candidates WHILE iterating them; that is only safe because `list`
    // is a snapshot rather than the live array.
    const c = createCandidateStamps();
    c.remember(at(1));
    const snapshot = c.list();
    c.clear();
    expect(snapshot).toEqual([at(1)]);
    expect(CANDIDATE_STAMP_CAP).toBeGreaterThan(0);
  });
});
