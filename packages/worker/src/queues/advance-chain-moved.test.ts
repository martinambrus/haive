import { describe, it, expect } from 'vitest';
import { advanceChainHasMoved } from './task-queue.js';

/** Guards the decision a duplicate advance-step delivery makes when it finds the step
 *  row already `done`: re-drive the hand-off, or return?
 *
 *  Re-driving unconditionally cascades — an advance for an already-done successor
 *  re-drives ITS successor down the chain. Never re-driving strands the chain when a
 *  job dies between advanceStep and handleResult. So it turns on whether the chain has
 *  demonstrably moved. */
describe('advanceChainHasMoved', () => {
  it('is false when the task still points at this step and round', () => {
    // The hand-off has not happened, so the duplicate should re-drive it.
    expect(advanceChainHasMoved({ currentStepId: '08', currentRound: 0 }, '08', 0)).toBe(false);
  });

  it('is true when the task has moved to a later step', () => {
    // Observed shape: 08 finished, the chain reached 08c, then a second 08 job landed.
    expect(advanceChainHasMoved({ currentStepId: '08c', currentRound: 0 }, '08', 0)).toBe(true);
  });

  it('is true when the same step advanced to a later fix-loop round', () => {
    // A round bump is a real move even though the step id is unchanged — round N's row
    // is a different row from round N-1's.
    expect(advanceChainHasMoved({ currentStepId: '07', currentRound: 1 }, '07', 0)).toBe(true);
  });

  it('treats a null currentStepId as NOT evidence', () => {
    // A task that has not advanced yet tells us nothing about the hand-off. Answering
    // "moved" here would strand it; answering "not moved" re-drives, which is safe.
    expect(advanceChainHasMoved({ currentStepId: null, currentRound: 0 }, '08', 0)).toBe(false);
  });

  it('does not treat an earlier round as unmoved', () => {
    // Defensive: any round mismatch is a mismatch, in either direction.
    expect(advanceChainHasMoved({ currentStepId: '07', currentRound: 0 }, '07', 1)).toBe(true);
  });
});
