import { describe, expect, it } from 'vitest';
import { LEARNED_TIMEOUT_MAX_MS, learnedLadderBaseMs } from './dispatch-timeout.js';

const MIN = 60_000;

describe('learnedLadderBaseMs', () => {
  it('returns undefined when nothing is declared and nothing was learned', () => {
    // Undeclared must STAY undeclared: escalatedTimeoutMs reads undefined as "use the
    // configured floor". Substituting a number here would change every step that never
    // declared a budget, as a side effect of adding learning.
    expect(learnedLadderBaseMs(undefined, null)).toBeUndefined();
    expect(learnedLadderBaseMs(undefined, 0)).toBeUndefined();
  });

  it('keeps the declared budget when nothing was learned', () => {
    expect(learnedLadderBaseMs(30 * MIN, null)).toBe(30 * MIN);
  });

  it('raises the base to the learned budget when it is larger', () => {
    // The whole point: round N proved 90 minutes, so round N+1 starts there instead of
    // re-burning the declared 30.
    expect(learnedLadderBaseMs(30 * MIN, 90 * MIN)).toBe(90 * MIN);
  });

  it('keeps the declared budget when it already exceeds what was learned', () => {
    expect(learnedLadderBaseMs(120 * MIN, 45 * MIN)).toBe(120 * MIN);
  });

  it('supplies the learned budget for a step that declares nothing', () => {
    expect(learnedLadderBaseMs(undefined, 90 * MIN)).toBe(90 * MIN);
  });

  it('clamps a learned budget to the retry endpoint ceiling', () => {
    // A learned value can only grow by one ladder-worth per round, but it must not be able
    // to walk past the 480-minute ceiling the retry endpoint already enforces on a human pin.
    expect(learnedLadderBaseMs(30 * MIN, 900 * MIN)).toBe(LEARNED_TIMEOUT_MAX_MS);
  });

  it('ignores a non-positive learned value', () => {
    // 0 / negative can only mean "cleared" — treat it as absent rather than as a budget.
    expect(learnedLadderBaseMs(30 * MIN, 0)).toBe(30 * MIN);
    expect(learnedLadderBaseMs(30 * MIN, -1)).toBe(30 * MIN);
  });
});
