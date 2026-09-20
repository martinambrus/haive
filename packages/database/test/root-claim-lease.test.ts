import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOT_CLAIM_RENEW_MS, acquireRootClaim } from '../src/repo-root-claim.js';
import type { Database } from '../src/index.js';

/**
 * The lease's in-process SEQUENCING, which is the one part of it a fake can prove.
 *
 * The SQL — who may claim, who may take over, who may renew — is covered against a real database
 * by `smoke:reset-claim`, because a fake that answers whatever the shape demands proves only that
 * the shape was copied. What a fake CAN prove is ordering, and the bug this exists for is purely
 * an ordering one: a release firing while a renewal is in flight used to capture the old stamp,
 * match nothing, and report success having cleared nothing — leaving the repository claimed for a
 * whole window after the writer had finished.
 */

interface Recorded {
  /** The value written to `root_claimed_at`: a Date for a claim or renewal, null for a release. */
  stamp: Date | null;
  /** Resolves the query, so a test can hold one in flight. */
  settle: () => void;
}

function fakeDb(): { db: Database; writes: Recorded[] } {
  const writes: Recorded[] = [];
  const db = {
    update: () => ({
      set: (values: { rootClaimedAt: Date | null }) => ({
        where: () => {
          let settle!: () => void;
          const gate = new Promise<void>((resolve) => {
            settle = resolve;
          });
          const record: Recorded = { stamp: values.rootClaimedAt, settle };
          writes.push(record);
          return {
            returning: async () => {
              await gate;
              return [{ id: 'repo-1' }];
            },
          };
        },
      }),
    }),
  } as unknown as Database;
  return { db, writes };
}

/** Same fake, except every write after the initial claim matches no row — which is exactly what a
 *  takeover looks like to the holder: its conditional UPDATE finds the stamp already replaced. */
function fakeDbLosingRenewal(): { db: Database; writes: Recorded[] } {
  const writes: Recorded[] = [];
  const db = {
    update: () => ({
      set: (values: { rootClaimedAt: Date | null }) => ({
        where: () => {
          let settle!: () => void;
          const gate = new Promise<void>((resolve) => {
            settle = resolve;
          });
          const first = writes.length === 0;
          writes.push({ stamp: values.rootClaimedAt, settle });
          return {
            returning: async () => {
              await gate;
              return first ? [{ id: 'repo-1' }] : [];
            },
          };
        },
      }),
    }),
  } as unknown as Database;
  return { db, writes };
}

/**
 * A fake whose RENEWAL commits and then loses its acknowledgement: the update rejects, while the
 * row goes on to hold the stamp that update was writing. `rowStamp` decides what a read-back
 * finds — the attempted stamp (the write landed), or a third value (someone took the lease).
 */
function fakeDbAmbiguousRenewal(rowStamp: 'attempted' | 'stranger'): {
  db: Database;
  writes: Recorded[];
  selects: number;
} {
  const writes: Recorded[] = [];
  let attempted: Date | null = null;
  const state = { selects: 0 };
  const db = {
    update: () => ({
      set: (values: { rootClaimedAt: Date | null }) => ({
        where: () => {
          const first = writes.length === 0;
          if (!first && values.rootClaimedAt !== null) attempted = values.rootClaimedAt;
          let settle!: () => void;
          const gate = new Promise<void>((resolve) => {
            settle = resolve;
          });
          writes.push({ stamp: values.rootClaimedAt, settle });
          return {
            returning: async () => {
              await gate;
              // The claim succeeds; the renewal rejects AFTER having written.
              if (!first && values.rootClaimedAt !== null) throw new Error('connection lost');
              return [{ id: 'repo-1' }];
            },
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.selects += 1;
            const claimedAt =
              rowStamp === 'attempted' ? attempted : new Date('2030-01-01T00:00:00Z');
            return [{ claimedAt }];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return {
    db,
    writes,
    get selects() {
      return state.selects;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('acquireRootClaim', () => {
  it('waits for an in-flight renewal before releasing, and clears the renewed stamp', async () => {
    vi.useFakeTimers();
    const { db, writes } = fakeDb();

    const acquiring = acquireRootClaim(db, 'repo-1', 'rebuild');
    writes[0]!.settle(); // the initial claim
    const handle = await acquiring;
    expect(handle).not.toBeNull();

    // Drive the timer to start a renewal, and leave that query pending.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    expect(writes).toHaveLength(2);
    const renewal = writes[1]!;
    expect(renewal.stamp).toBeInstanceOf(Date);

    // Release while the renewal is still in flight. It must not finish, and must not have issued
    // its clearing write yet — that write is what would carry the STALE stamp and match nothing.
    let released = false;
    const releasing = handle!.release().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(false);
    expect(writes).toHaveLength(2);

    // Let the renewal land; only now may the release write, and it clears rather than stamps.
    renewal.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(3);
    writes[2]!.settle();
    await releasing;
    expect(released).toBe(true);
    expect(writes[2]!.stamp).toBeNull();
  });

  it('keeps renewing for as long as the holder works, with no elapsed-time cap', async () => {
    // A cap was tried and reverted under review. `gitClone` has no timeout and `copyTree` is
    // unbounded by repository size, so ANY elapsed-time deadline eventually expires a holder that
    // is still rewriting the tree — and a second writer then claims and replaces the same tree,
    // which is the catastrophe this whole mechanism exists to prevent. Renewal ends at
    // `release()` and nowhere else.
    vi.useFakeTimers();
    const { db, writes } = fakeDb();

    const acquiring = acquireRootClaim(db, 'repo-1', 'rebuild');
    writes[0]!.settle();
    const handle = await acquiring;

    // Four hours of work — double any cap that was ever proposed here.
    const ticks = Math.ceil((4 * 60 * 60 * 1000) / ROOT_CLAIM_RENEW_MS);
    for (let i = 0; i < ticks; i += 1) {
      await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
      writes.at(-1)!.settle();
      await vi.advanceTimersByTimeAsync(0);
    }
    // Still renewing: one write per tick beyond the initial claim.
    expect(writes.length).toBe(ticks + 1);
    expect(writes.at(-1)!.stamp).toBeInstanceOf(Date);

    const releasing = handle!.release();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await releasing;
    // And the release still clears, rather than stamping.
    expect(writes.at(-1)!.stamp).toBeNull();
  });

  it('reports a lost lease from the moment the renewal loses it', async () => {
    // The flag is set where the loss is LEARNED, not where it is noticed, so it must already be
    // true before anyone releases — a caller that wants to stop early has nothing else to ask.
    vi.useFakeTimers();
    const { db, writes } = fakeDbLosingRenewal();

    const acquiring = acquireRootClaim(db, 'repo-1', 'rebuild');
    writes[0]!.settle();
    const handle = await acquiring;
    expect(handle!.lost()).toBe(false);

    // The renewal's conditional UPDATE matches nothing: someone else holds the row now.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle!.lost()).toBe(true);

    // And releasing a lost lease writes NOTHING — the stamp on the row is the other writer's.
    const before = writes.length;
    await handle!.release();
    expect(writes).toHaveLength(before);
    expect(handle!.lost()).toBe(true);
  });

  it('does not report a loss after an ordinary release, or after a second one', async () => {
    // Both a normal release and a takeover end with no stamp in hand, so deriving the flag from
    // that would make every completed job report itself taken over — and the error log that exists
    // to find the one real case would cry wolf. The second release is the sharper version of the
    // same mistake: the interface promises it is safe, so it must not manufacture a verdict.
    vi.useFakeTimers();
    const { db, writes } = fakeDb();

    const acquiring = acquireRootClaim(db, 'repo-1', 'reset');
    writes[0]!.settle();
    const handle = await acquiring;

    const releasing = handle!.release();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await releasing;
    expect(handle!.lost()).toBe(false);

    await handle!.release();
    expect(handle!.lost()).toBe(false);
  });

  it('adopts the attempted stamp when a renewal committed but lost its acknowledgement', async () => {
    // A write that fails AFTER committing looks identical to one that never ran. Keeping the old
    // stamp there leaves the row holding a value nothing will ever match again: the release
    // clears nothing, the next renewal reports the lease lost, and the repository stays claimed
    // for the rest of the window with nobody working on it. Reading the row back is the only
    // honest answer.
    vi.useFakeTimers();
    const fake = fakeDbAmbiguousRenewal('attempted');

    const acquiring = acquireRootClaim(fake.db, 'repo-1', 'reset');
    fake.writes[0]!.settle();
    const handle = await acquiring;

    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    fake.writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);

    // The lease is still OURS: reconciled, not abandoned.
    expect(fake.selects).toBeGreaterThan(0);
    expect(handle!.lost()).toBe(false);

    // And the release still clears, rather than silently matching nothing.
    const before = fake.writes.length;
    const releasing = handle!.release();
    await vi.advanceTimersByTimeAsync(0);
    fake.writes.at(-1)!.settle();
    await releasing;
    expect(fake.writes.length).toBeGreaterThan(before);
    expect(fake.writes.at(-1)!.stamp).toBeNull();
  });

  it('treats a third stamp on the row as a genuine takeover', async () => {
    // The other half: the read-back must not rescue a lease somebody else now holds, or the
    // release would clear THEIR claim and strip the protection this whole mechanism provides.
    vi.useFakeTimers();
    const fake = fakeDbAmbiguousRenewal('stranger');

    const acquiring = acquireRootClaim(fake.db, 'repo-1', 'rebuild');
    fake.writes[0]!.settle();
    const handle = await acquiring;

    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    fake.writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(handle!.lost()).toBe(true);

    // Releasing a lost lease writes NOTHING.
    const before = fake.writes.length;
    await handle!.release();
    expect(fake.writes.length).toBe(before);
  });

  it('never runs two renewals at once', async () => {
    vi.useFakeTimers();
    const { db, writes } = fakeDb();

    const acquiring = acquireRootClaim(db, 'repo-1', 'reset');
    writes[0]!.settle();
    const handle = await acquiring;

    // One renewal in flight; several more intervals elapse. A second concurrent renewal would
    // race the first on the same stamp, and the loser would read as a lost lease.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS * 3);
    expect(writes).toHaveLength(2);

    writes[1]!.settle();
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    expect(writes).toHaveLength(3);

    writes[2]!.settle();
    const releasing = handle!.release();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await releasing;
  });
});
