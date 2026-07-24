import { describe, it, expect } from 'vitest';
import { isCurrentStep } from './task-queue.js';

const row = (over: Partial<Parameters<typeof isCurrentStep>[0]> = {}) => ({
  stepId: '06a-db-migrate',
  round: 0,
  currentStepId: '06a-db-migrate',
  currentRound: 0,
  ...over,
});

describe('isCurrentStep', () => {
  it('matches the task’s current step', () => {
    expect(isCurrentStep(row())).toBe(true);
  });

  it('rejects a different step — an abandoned chain', () => {
    // The state that produced two park loops on one task: a task-level retry walked to
    // 06a-db-migrate while 07b-phase-4-validate round 1 was left over from the fix loop, and
    // boot reconcile re-drove the leftover at the task's CURRENT epoch, so the epoch guard saw
    // both jobs as live.
    expect(isCurrentStep(row({ stepId: '07b-phase-4-validate', round: 1 }))).toBe(false);
  });

  it('rejects a different ROUND of the same step', () => {
    // A fix loop materializes one row per round; only the current round is live.
    expect(isCurrentStep(row({ round: 1 }))).toBe(false);
    expect(isCurrentStep(row({ round: 0, currentRound: 2 }))).toBe(false);
  });

  it('treats every step as current when the task has not advanced yet', () => {
    // No current step = nothing to compete with, so recovery must not refuse to act (refusing
    // would leave the orphan unrecovered and the task wedged).
    expect(isCurrentStep(row({ currentStepId: null }))).toBe(true);
    expect(isCurrentStep(row({ currentStepId: null, stepId: 'anything', round: 7 }))).toBe(true);
  });
});
