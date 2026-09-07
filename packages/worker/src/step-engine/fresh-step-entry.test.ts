import { describe, it, expect } from 'vitest';
import { isFreshStepEntry } from './step-runner.js';

/** Guards which advanceStep calls may re-ask `shouldRun`.
 *
 *  A step whose own work falsifies its precondition — the plan builder creates the root its
 *  `extraShouldRun` checks for — abandons its in-flight agents the moment a continuation is
 *  re-gated. So only a first entry asks. */
describe('isFreshStepEntry', () => {
  it('is true for a pending row, the only status a first entry has', () => {
    expect(isFreshStepEntry('pending')).toBe(true);
  });

  it('is false for a mining wave re-entry', () => {
    // MiningWaveError parks waiting_cli and returns; the next agent to finish re-enters here.
    expect(isFreshStepEntry('waiting_cli')).toBe(false);
  });

  it('is false for a form submission re-entry', () => {
    expect(isFreshStepEntry('waiting_form')).toBe(false);
  });

  it('is false for every other continuation status', () => {
    for (const status of ['running', 'done', 'failed', 'skipped'] as const) {
      expect(isFreshStepEntry(status)).toBe(false);
    }
  });
});
