import { describe, it, expect } from 'vitest';
import {
  clampVoteScore,
  fairPriority,
  repricedPriority,
  FAIR_PRIORITY_MAX,
  FAIR_PRIORITY_MIN,
  TASK_VOTE_MAX,
  TASK_VOTE_MIN,
} from './fair-priority.js';

/** The pre-vote formula, verbatim from task-queue.ts before this module existed. Every
 *  zero-score assertion below compares against it, because "score 0 changes nothing" is the
 *  property that makes rolling this out a no-op. */
function legacyPriority(rank: number, tiebreak: number): number {
  return Math.min(Math.max(rank, 1), 2000) * 1000 + Math.min(tiebreak, 999);
}

/** BullMQ scores a prioritized job as `priority * 2^32 + counter` into a Redis ZSET, whose
 *  score is a double. Above 2^21 the multiplication stops being exact and the ordering
 *  silently degrades. */
const BULLMQ_PRIORITY_CEILING = 2 ** 21;

describe('fairPriority', () => {
  it('score 0 keeps the legacy ordering, offset by one constant band', () => {
    const cases: Array<[number, number]> = [
      [1, 0],
      [1, 999],
      [3, 12],
      [2000, 400],
    ];
    const offsets = cases.map(
      ([rank, tiebreak]) =>
        fairPriority({ rank, tiebreak, score: 0 }) - legacyPriority(rank, tiebreak),
    );
    expect(new Set(offsets).size).toBe(1);
    expect(offsets[0]).toBe(TASK_VOTE_MAX * 1000);
  });

  it('an upvoted serial task outranks a neutral one (the case rank-clamping alone loses)', () => {
    const neutral = fairPriority({ rank: 1, tiebreak: 0, score: 0 });
    const boosted = fairPriority({ rank: 1, tiebreak: 0, score: 5 });
    expect(boosted).toBeLessThan(neutral);
  });

  it('a fully boosted task still outranks a neutral task at every rank it can reach', () => {
    // MAX_PARALLEL_AGENTS_PER_TASK defaults to 5, so rank 5 is the deepest a task goes.
    for (let rank = 1; rank <= 5; rank++) {
      expect(fairPriority({ rank, tiebreak: 0, score: 5 })).toBeLessThanOrEqual(
        fairPriority({ rank: 1, tiebreak: 0, score: 0 }),
      );
    }
  });

  it('downvoting sends a task behind a neutral one', () => {
    expect(fairPriority({ rank: 1, tiebreak: 0, score: -5 })).toBeGreaterThan(
      fairPriority({ rank: 1, tiebreak: 0, score: 0 }),
    );
  });

  it('rank still climbs under a boost, so nothing starves', () => {
    const first = fairPriority({ rank: 1, tiebreak: 0, score: 5 });
    const fifth = fairPriority({ rank: 5, tiebreak: 0, score: 5 });
    expect(fifth).toBeGreaterThan(first);
  });

  it('the vote never crosses band boundaries into the user tiebreak', () => {
    // Same band, busier user -> sorts later. Boosting must not let a loaded user jump a
    // quiet one within the band.
    expect(fairPriority({ rank: 1, tiebreak: 900, score: 3 })).toBeGreaterThan(
      fairPriority({ rank: 1, tiebreak: 0, score: 3 }),
    );
  });

  it('stays inside [FAIR_PRIORITY_MIN, FAIR_PRIORITY_MAX] and under the BullMQ ceiling', () => {
    for (const rank of [-5, 0, 1, 7, 2000, 99999]) {
      for (const tiebreak of [-1, 0, 999, 5000]) {
        for (const score of [-99, -5, 0, 5, 99]) {
          const p = fairPriority({ rank, tiebreak, score });
          expect(p).toBeGreaterThanOrEqual(FAIR_PRIORITY_MIN);
          expect(p).toBeLessThanOrEqual(FAIR_PRIORITY_MAX);
        }
      }
    }
    expect(FAIR_PRIORITY_MAX).toBeLessThan(BULLMQ_PRIORITY_CEILING);
  });

  it('is never 0 — BullMQ routes priority 0 to the wait list, out of the ordering', () => {
    expect(fairPriority({ rank: 1, tiebreak: 0, score: TASK_VOTE_MAX })).toBeGreaterThan(0);
    expect(FAIR_PRIORITY_MIN).toBeGreaterThan(0);
  });

  it('clamps an out-of-range stored score rather than trusting the row', () => {
    expect(fairPriority({ rank: 1, tiebreak: 0, score: 500 })).toBe(
      fairPriority({ rank: 1, tiebreak: 0, score: TASK_VOTE_MAX }),
    );
    expect(fairPriority({ rank: 1, tiebreak: 0, score: -500 })).toBe(
      fairPriority({ rank: 1, tiebreak: 0, score: TASK_VOTE_MIN }),
    );
  });
});

describe('repricedPriority', () => {
  it('repricing a queued job lands exactly where a fresh enqueue would', () => {
    for (const rank of [1, 2, 5, 2000]) {
      for (const tiebreak of [0, 42, 999]) {
        for (const from of [-5, -1, 0, 3, 5]) {
          for (const to of [-5, 0, 1, 5]) {
            const queued = fairPriority({ rank, tiebreak, score: from });
            expect(repricedPriority(queued, to - from)).toBe(
              fairPriority({ rank, tiebreak, score: to }),
            );
          }
        }
      }
    }
  });

  it('a no-op delta leaves the priority untouched', () => {
    const p = fairPriority({ rank: 2, tiebreak: 7, score: 1 });
    expect(repricedPriority(p, 0)).toBe(p);
  });

  it('never escapes the priority bounds', () => {
    expect(repricedPriority(FAIR_PRIORITY_MIN, 10)).toBeGreaterThanOrEqual(FAIR_PRIORITY_MIN);
    expect(repricedPriority(FAIR_PRIORITY_MAX, -10)).toBeLessThanOrEqual(FAIR_PRIORITY_MAX);
  });
});

describe('clampVoteScore', () => {
  it('stops at the arrow limits', () => {
    expect(clampVoteScore(TASK_VOTE_MAX + 1)).toBe(TASK_VOTE_MAX);
    expect(clampVoteScore(TASK_VOTE_MIN - 1)).toBe(TASK_VOTE_MIN);
    expect(clampVoteScore(0)).toBe(0);
    expect(clampVoteScore(3)).toBe(3);
  });
});
