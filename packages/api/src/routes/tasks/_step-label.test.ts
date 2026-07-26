import { describe, expect, it } from 'vitest';
import { currentStepLabel, deriveRoundSuffixes, type StepLabelRow } from './_step-label.js';

const step = (over: Partial<StepLabelRow> = {}): StepLabelRow => ({
  stepId: '07b-phase-4-validate',
  round: 0,
  title: 'Phase 4: Implementation validation',
  iterationCount: 0,
  ...over,
});

describe('currentStepLabel', () => {
  it('returns the human title, never the step slug', () => {
    expect(currentStepLabel([step()], '07b-phase-4-validate', 0)).toBe(
      'Phase 4: Implementation validation',
    );
  });

  it('suffixes the fix-loop round the step is on', () => {
    const steps = [
      step({ round: 0 }),
      step({ stepId: '07-phase-2-implement', round: 1, title: 'Implement' }),
      step({ round: 1 }),
    ];
    expect(currentStepLabel(steps, '07b-phase-4-validate', 1)).toBe(
      'Phase 4: Implementation validation (fix loop 1)',
    );
  });

  it('numbers fix loops and spec revisions independently as rounds interleave', () => {
    const steps = [
      step({ round: 0 }),
      step({ stepId: '07-phase-2-implement', round: 1, title: 'Implement' }),
      step({ stepId: '04-phase-0b-pre-planning', round: 2, title: 'Pre-planning' }),
      step({ stepId: '07-phase-2-implement', round: 3, title: 'Implement' }),
    ];
    const byRound = deriveRoundSuffixes(steps);
    expect(byRound.get(1)).toBe('fix loop 1');
    expect(byRound.get(2)).toBe('spec rev 1');
    // Round 3 is the SECOND fix loop even though it is the third round.
    expect(byRound.get(3)).toBe('fix loop 2');
  });

  it('falls back to the in-place pass count on round 0', () => {
    // A step with no CLI roles does one pass per iteration, so passes are reported as-is.
    const plain = step({ stepId: '03-phase-0a-discovery', title: 'Discovery', iterationCount: 3 });
    expect(currentStepLabel([plain], '03-phase-0a-discovery', 0)).toBe('Discovery (iter ×3)');
  });

  it('reports a role-split step in ROUNDS, since each round costs one pass per role', () => {
    // 07b runs validator + fixer, so 3 raw iterations is 2 rounds — matching the per-step
    // badge on the task page rather than inventing a second convention for the same number.
    expect(currentStepLabel([step({ iterationCount: 3 })], '07b-phase-4-validate', 0)).toBe(
      'Phase 4: Implementation validation (round ×2)',
    );
  });

  it('adds no suffix on an untouched first pass (never an empty bracket)', () => {
    expect(currentStepLabel([step()], '07b-phase-4-validate', 0)).not.toContain('(');
  });

  it('matches on round, so a round-0 row does not label a round-2 pointer', () => {
    expect(currentStepLabel([step({ round: 0 })], '07b-phase-4-validate', 2)).toBeNull();
  });

  it('is null when the task has no current step or the row is missing', () => {
    expect(currentStepLabel([step()], null, 0)).toBeNull();
    expect(currentStepLabel([], '07b-phase-4-validate', 0)).toBeNull();
  });
});
