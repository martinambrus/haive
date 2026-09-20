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

/**
 * The compound failure: the renewal's acknowledgement is lost AND the reconciliation read fails
 * too, so the holder cannot learn which stamp the row carries. The row does hold the attempted
 * one. A later renewal from the OLD stamp therefore misses — and that miss must not be read as a
 * takeover, or renewal stops on a lease still protecting live work.
 */
function fakeDbUnprovenRenewal(): { db: Database; writes: Recorded[] } {
  const writes: Recorded[] = [];
  const db = {
    update: () => ({
      set: (values: { rootClaimedAt: Date | null }) => ({
        where: () => {
          const idx = writes.length;
          let settle!: () => void;
          const gate = new Promise<void>((resolve) => {
            settle = resolve;
          });
          writes.push({ stamp: values.rootClaimedAt, settle });
          return {
            returning: async () => {
              await gate;
              if (idx === 0) return [{ id: 'repo-1' }]; // the claim
              // Commits, then loses its acknowledgement.
              if (idx === 1) throw new Error('connection lost');
              // The fake cannot inspect the WHERE, so it answers by POSITION: the next renewal
              // (from the stale stamp) misses, and the recovery attempt (from the stamp that
              // write left behind) lands.
              if (idx === 2) return [];
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
            throw new Error('read failed too');
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { db, writes };
}

/**
 * Every write is ambiguous and every read fails: the first renewal commits without an
 * acknowledgement, the read-back fails, the later renewal from the stale stamp misses, and the
 * RECOVERY write is ambiguous too. Nothing here proves a takeover, so nothing may conclude one.
 */
function fakeDbAllAmbiguous(): { db: Database; writes: Recorded[] } {
  const writes: Recorded[] = [];
  const db = {
    update: () => ({
      set: (values: { rootClaimedAt: Date | null }) => ({
        where: () => {
          const idx = writes.length;
          let settle!: () => void;
          const gate = new Promise<void>((resolve) => {
            settle = resolve;
          });
          writes.push({ stamp: values.rootClaimedAt, settle });
          return {
            returning: async () => {
              await gate;
              if (idx === 0) return [{ id: 'repo-1' }]; // the claim
              if (idx === 1) throw new Error('ack lost'); // renewal 1: committed, unacknowledged
              if (idx === 2) return []; // renewal 2 from the stale stamp: misses
              throw new Error('ack lost again'); // the recovery write: ambiguous as well
            },
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            throw new Error('read failed');
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { db, writes };
}

/**
 * The INITIAL claim commits and loses its acknowledgement. `rowStamp` decides what the read-back
 * then finds: the stamp that write attempted (we own the claim after all), a stranger's (we do
 * not), or nothing at all (the write never landed, and the failure is real).
 */
function fakeDbAmbiguousClaim(rowStamp: 'attempted' | 'stranger' | 'empty'): {
  db: Database;
  writes: Recorded[];
} {
  const writes: Recorded[] = [];
  let attempted: Date | null = null;
  const db = {
    update: () => ({
      set: (values: { rootClaimedAt: Date | null }) => ({
        where: () => {
          const first = writes.length === 0;
          if (first) attempted = values.rootClaimedAt;
          let settle!: () => void;
          const gate = new Promise<void>((resolve) => {
            settle = resolve;
          });
          writes.push({ stamp: values.rootClaimedAt, settle });
          return {
            returning: async () => {
              await gate;
              if (first) throw new Error('claim ack lost');
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
            if (rowStamp === 'empty') return [{ claimedAt: null }];
            if (rowStamp === 'stranger') return [{ claimedAt: new Date('2030-01-01T00:00:00Z') }];
            return [{ claimedAt: attempted }];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { db, writes };
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

  it('recovers when the renewal AND its reconciliation both fail, rather than declaring a takeover', async () => {
    // The read-back can fail too, and then keeping the old stamp is a GUESS. If the write did
    // land, the next healthy renewal matches nothing — and reading that miss as a takeover stops
    // renewal on a lease that is still protecting a clone or reset in progress. After the stale
    // window a second writer then enters the same tree, which is the one outcome this whole
    // mechanism exists to prevent. So an unproven stamp is carried and tried before concluding.
    vi.useFakeTimers();
    const { db, writes } = fakeDbUnprovenRenewal();

    const acquiring = acquireRootClaim(db, 'repo-1', 'rebuild');
    writes[0]!.settle();
    const handle = await acquiring;

    // Renewal 1: commits, loses its ack, and the reconciliation read fails as well.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle!.lost()).toBe(false);

    // Renewal 2: the stale stamp misses, the carried stamp recovers. Settle both writes.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);

    // Still ours: the miss was reconciled, not read as somebody else's claim.
    expect(handle!.lost()).toBe(false);
  });

  it('releases using the unproven stamp when clearing the held one matches nothing', async () => {
    // The half the renewal fix did not cover, and the likelier one: a job that FINISHES right
    // after an unprovable renewal. `current` is then a guess, the conditional clear matches no
    // row, and a release that matched nothing looks exactly like success — so the holder reports
    // a clean finish and leaves the repository claimed for the rest of the window.
    vi.useFakeTimers();
    const { db, writes } = fakeDbUnprovenRenewal();

    const acquiring = acquireRootClaim(db, 'repo-1', 'reset');
    writes[0]!.settle();
    const handle = await acquiring;

    // Renewal 1: commits, loses its ack, and the read-back fails too.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);

    // Release: the first clear (index 2) matches nothing, so a second clear must follow.
    const before = writes.length;
    const releasing = handle!.release();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await releasing;

    const clears = writes.slice(before).filter((w) => w.stamp === null);
    expect(clears.length).toBe(2);
  });

  it('does not declare a takeover when the RECOVERY write is ambiguous too', async () => {
    // The recovery write is a conditional write like any other, so it carries the same
    // commit-without-acknowledgement ambiguity. Converting its exception straight to "lost"
    // stops renewal on a lease that may still be ours — and after the stale window a second
    // writer enters the tree this one is still rewriting, which is the catastrophe the whole
    // mechanism exists to prevent. "I could not tell" is not "somebody else has it".
    vi.useFakeTimers();
    const { db, writes } = fakeDbAllAmbiguous();

    const acquiring = acquireRootClaim(db, 'repo-1', 'rebuild');
    writes[0]!.settle();
    const handle = await acquiring;

    // Renewal 1: ambiguous, read-back fails.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(handle!.lost()).toBe(false);

    // Renewal 2: the stale stamp misses, and the recovery write is ambiguous as well.
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await vi.advanceTimersByTimeAsync(0);

    // Still ours as far as anyone can prove, so renewal must not have stopped.
    expect(handle!.lost()).toBe(false);

    // NOT covered here, and stated rather than implied: the BRANCH ORDER inside the recovery.
    // `proven` must be tested before the stamp, because an unproven answer always carries a
    // non-null stamp (the reconciler falls back to the one it was given) — so a stamp-first test
    // swallows the ambiguous case, adopting that stamp as certain AND clearing the outstanding
    // one. Both orderings leave `lost()` false here, and driving this fake to the later cycle
    // where they diverge turns the test into an exercise in timer sequencing rather than in
    // behaviour. The ordering is argued in the source comment instead.
  });

  it('adopts an INITIAL claim that committed without an acknowledgement', async () => {
    // The one conditional write that had no reconciliation. When it throws, the caller never
    // reaches the `try` whose `finally` releases — so a claim that DID land leaves the
    // repository blocked for the whole stale window with nobody holding it: edits and resets
    // refused, and a repo job burning its retries into `error`.
    vi.useFakeTimers();
    const { db, writes } = fakeDbAmbiguousClaim('attempted');

    const acquiring = acquireRootClaim(db, 'repo-1', 'reset');
    writes[0]!.settle();
    const handle = await acquiring;

    expect(handle).not.toBeNull();
    expect(handle!.lost()).toBe(false);

    // And it can be released, which is the entire point of getting a handle back.
    const before = writes.length;
    const releasing = handle!.release();
    await vi.advanceTimersByTimeAsync(0);
    writes.at(-1)!.settle();
    await releasing;
    expect(writes.length).toBeGreaterThan(before);
    expect(writes.at(-1)!.stamp).toBeNull();
  });

  it('refuses when the row shows the claim is someone else', async () => {
    // A stranger's stamp means our write did not win the CAS. Returning a handle there would let
    // the caller rewrite a tree another writer is protecting.
    vi.useFakeTimers();
    const { db, writes } = fakeDbAmbiguousClaim('stranger');

    const acquiring = acquireRootClaim(db, 'repo-1', 'reset');
    writes[0]!.settle();
    expect(await acquiring).toBeNull();
  });

  it('rethrows when the row proves nothing landed, rather than reporting a refusal', async () => {
    // An empty claim column means the write never landed, so this is a real database failure —
    // not "someone else is resetting". Reporting a refusal would answer 409 for an outage and
    // send the user to wait for a reset that is not running.
    vi.useFakeTimers();
    const { db, writes } = fakeDbAmbiguousClaim('empty');

    const acquiring = acquireRootClaim(db, 'repo-1', 'reset');
    writes[0]!.settle();
    await expect(acquiring).rejects.toThrow('claim ack lost');
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
