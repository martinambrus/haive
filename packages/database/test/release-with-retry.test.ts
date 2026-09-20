import { describe, expect, it } from 'vitest';
import { releaseWithRetry } from '../src/repo-root-claim.js';
import type { Database } from '../src/index.js';

/**
 * The bounded re-attempt behind every clear of the claim row.
 *
 * Tested directly rather than through `acquireRootClaim`, for the same reason
 * `createCandidateStamps` is: reaching this path through the lease means driving a fake database
 * across renewal cycles on fake timers, which tests the harness more than the behaviour. The
 * property here is simple and worth asserting plainly — an UNSETTLED outcome is retried, a
 * settled one is not, and the retry is bounded.
 *
 * Both clear paths in `release()` call this same function, which is the point of extracting it:
 * the previous shape applied the retry to the primary clear and not to the candidates, leaving it
 * absent from the case it exists for — an ambiguous renewal makes the CANDIDATE loop the only
 * release path there is.
 */

const STAMP = new Date('2026-09-20T12:00:00Z');

/** A db whose clear behaves as `script` says, one entry per attempt, and whose read-back reports
 *  `rowHolds`. `'commit'` clears the row, `'miss'` is a clean no-match, `'throw'` fails. */
function fakeDb(script: Array<'commit' | 'miss' | 'throw'>, rowHolds: Date | null) {
  const state = { attempts: 0, reads: 0, cleared: false };
  const db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            const action = script[state.attempts] ?? 'throw';
            state.attempts += 1;
            if (action === 'throw') throw new Error('clear failed');
            if (action === 'miss') return [];
            state.cleared = true;
            return [{ id: 'repo-1' }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            state.reads += 1;
            return [{ claimedAt: state.cleared ? null : rowHolds }];
          },
        }),
      }),
    }),
  } as unknown as Database;
  return { db, state };
}

describe('releaseWithRetry', () => {
  it('retries while the row provably still carries the stamp, and stops once it is free', async () => {
    // "The write did not commit" is the one retryable outcome, and the ordinary release has no
    // other candidate to fall through to — so giving up here left a finished job holding the
    // repository for the rest of the stale window.
    const { db, state } = fakeDb(['throw', 'throw', 'commit'], STAMP);
    expect(await releaseWithRetry(db, 'repo-1', STAMP)).toBe('free');
    expect(state.attempts).toBe(3);
  });

  it('reports a row that is already free, without retrying', async () => {
    // A clean no-match over an empty row: somebody freed it, nothing left to do, and nothing was
    // taken from us.
    const { db, state } = fakeDb(['miss'], null);
    expect(await releaseWithRetry(db, 'repo-1', STAMP)).toBe('free');
    expect(state.attempts).toBe(1);
  });

  it('reports a TAKEOVER when a clean no-match finds a foreign stamp', async () => {
    // The distinction the caller needs and an unmatched clear cannot give on its own. If the
    // event loop was blocked past the stale window, another writer claimed the row before the
    // renewal timer ran again, and this release is the first thing to learn it — so the outcome
    // has to say "taken over" rather than merely "not this stamp", or `lost()` answers false and
    // the only warning that two writers touched the tree is never emitted.
    const other = new Date('2030-01-01T00:00:00Z');
    const { db, state } = fakeDb(['miss'], other);
    expect(await releaseWithRetry(db, 'repo-1', STAMP)).toBe('taken-over');
    expect(state.attempts).toBe(1);
  });

  it('reports a takeover found by the read-back after a failed clear, without retrying', async () => {
    // The write failed AND the row is held by a different stamp: settled, not ours to clear, and
    // established as a takeover. Retrying would be pointless at best.
    const other = new Date('2030-01-01T00:00:00Z');
    const { db, state } = fakeDb(['throw'], other);
    expect(await releaseWithRetry(db, 'repo-1', STAMP)).toBe('taken-over');
    expect(state.attempts).toBe(1);
  });

  it('does not call ANOTHER STAMP OF OURS a takeover', async () => {
    // The false alarm the previous shape produced, and the direction that matters most: `lost()`
    // is the signal that two writers touched one tree, so reporting it wrongly is worse than
    // missing it. An ambiguous renewal leaves the row holding a CANDIDATE while `current` is the
    // older stamp — so clearing `current` misses and finds a value that is ours, not a
    // stranger's, and the very next candidate clear would have proved it.
    const ourCandidate = new Date('2026-09-20T12:00:05Z');
    const { db } = fakeDb(['miss'], ourCandidate);
    expect(await releaseWithRetry(db, 'repo-1', STAMP, [STAMP, ourCandidate])).toBe('not-ours');
    // And with the same row value NOT among ours, it is a takeover again.
    const { db: foreign } = fakeDb(['miss'], ourCandidate);
    expect(await releaseWithRetry(foreign, 'repo-1', STAMP, [STAMP])).toBe('taken-over');
  });

  it('is bounded when nothing ever settles', async () => {
    // A database failing every write is not rescued by trying harder; the stale window is the
    // backstop for that, and a caller is waiting on this at the end of the work.
    const { db, state } = fakeDb(['throw', 'throw', 'throw', 'throw', 'throw'], STAMP);
    expect(await releaseWithRetry(db, 'repo-1', STAMP)).toBe('still-ours');
    expect(state.attempts).toBe(3);
  });

  it('retries an unreadable answer too, since nothing was established', async () => {
    // The clear failed and the read failed: `unknown`. A conditional clear that turns out to be
    // unnecessary is a harmless no-op, so trying again is the cheap side of the trade.
    const state = { attempts: 0 };
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              state.attempts += 1;
              if (state.attempts < 3) throw new Error('clear failed');
              return [{ id: 'repo-1' }];
            },
          }),
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

    expect(await releaseWithRetry(db, 'repo-1', STAMP)).toBe('free');
    expect(state.attempts).toBe(3);
  });
});
