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
