import { describe, it, expect } from 'vitest';
import { isAfterFrontier } from './step-order';

describe('isAfterFrontier', () => {
  it('orders within a round by run_seq', () => {
    expect(isAfterFrontier({ round: 0, runSeq: 28 }, { round: 0, runSeq: 27 })).toBe(true);
    expect(isAfterFrontier({ round: 0, runSeq: 26 }, { round: 0, runSeq: 27 })).toBe(false);
    expect(isAfterFrontier({ round: 0, runSeq: 27 }, { round: 0, runSeq: 27 })).toBe(false);
  });

  it('puts a LATER round below, even at a lower run_seq', () => {
    // The bug this exists for: task 35f34f22 failed at 08c2-code-audit round 0 (run_seq 31) with
    // fix-loop rounds 1..10 rendered below it. Comparing run_seq alone called every one of those
    // rows "upstream" (25, 27, 28 < 31), so each kept its own Retry/Stop/Skip below the failure.
    expect(isAfterFrontier({ round: 1, runSeq: 25 }, { round: 0, runSeq: 31 })).toBe(true);
    expect(isAfterFrontier({ round: 10, runSeq: 27 }, { round: 0, runSeq: 31 })).toBe(true);
  });

  it('keeps an EARLIER round above, even at a higher run_seq', () => {
    // Mirror case (38f02dee): the frontier is 07b-phase-4-validate round 1 (run_seq 26) while
    // round-0 rows 27..32 render ABOVE it. Those are history and keep their actions.
    expect(isAfterFrontier({ round: 0, runSeq: 32 }, { round: 1, runSeq: 26 })).toBe(false);
  });

  it('treats the same step in earlier fix-loop rounds as upstream', () => {
    // bf88b9a5 carries 07-phase-2-implement at run_seq 25 in rounds 1..6, the round-6 row being
    // the live frontier. The earlier rounds render above it and stay retryable.
    for (const round of [1, 2, 3, 4, 5]) {
      expect(isAfterFrontier({ round, runSeq: 25 }, { round: 6, runSeq: 25 })).toBe(false);
    }
    expect(isAfterFrontier({ round: 6, runSeq: 26 }, { round: 6, runSeq: 25 })).toBe(true);
  });

  it('never claims an unorderable row is downstream', () => {
    expect(isAfterFrontier({ round: 0, runSeq: null }, { round: 0, runSeq: 5 })).toBe(false);
    expect(isAfterFrontier({ round: 0, runSeq: 9 }, { round: 0, runSeq: null })).toBe(false);
    // …but round still decides when both rounds differ, run_seq or not.
    expect(isAfterFrontier({ round: 2, runSeq: null }, { round: 1, runSeq: null })).toBe(true);
  });
});
