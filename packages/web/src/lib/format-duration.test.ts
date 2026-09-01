import { describe, expect, it } from 'vitest';
import { formatTimeoutBudget } from './format-duration';

describe('formatTimeoutBudget', () => {
  it('keeps hour-scale timeout settings in minutes', () => {
    expect(formatTimeoutBudget(60 * 60 * 1000)).toBe('60m');
    expect(formatTimeoutBudget(90 * 60 * 1000)).toBe('90m');
  });

  it('preserves sub-minute and partial-minute budgets', () => {
    expect(formatTimeoutBudget(30_000)).toBe('30s');
    expect(formatTimeoutBudget(90_000)).toBe('1m 30s');
  });
});
