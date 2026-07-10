import { describe, it, expect } from 'vitest';
import {
  REVIEW_SEVERITIES,
  SEVERITY_WEIGHTS,
  coerceReviewSeverity,
  isBlockingSeverity,
  severityRank,
} from './severity.js';

describe('isBlockingSeverity', () => {
  it('treats only critical and high as the blocking tier', () => {
    expect(REVIEW_SEVERITIES.filter(isBlockingSeverity)).toEqual(['critical', 'high']);
  });
});

describe('severityRank', () => {
  it('orders most severe first, so a plain numeric sort puts critical on top', () => {
    const shuffled = ['low', 'critical', 'medium', 'high'] as const;
    expect([...shuffled].sort((a, b) => severityRank(a) - severityRank(b))).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
  });
});

describe('SEVERITY_WEIGHTS', () => {
  it('weights a critical miss above a low one', () => {
    expect(SEVERITY_WEIGHTS.critical).toBeGreaterThan(SEVERITY_WEIGHTS.high);
    expect(SEVERITY_WEIGHTS.high).toBeGreaterThan(SEVERITY_WEIGHTS.medium);
    expect(SEVERITY_WEIGHTS.medium).toBeGreaterThan(SEVERITY_WEIGHTS.low);
  });
});

describe('coerceReviewSeverity', () => {
  it('passes canonical values through, case- and space-insensitively', () => {
    expect(coerceReviewSeverity('critical', 'low')).toBe('critical');
    expect(coerceReviewSeverity('  High ', 'low')).toBe('high');
  });

  it('maps every pre-ladder vocabulary a repo persona may still specify', () => {
    // peer / lens / code-audit
    expect(coerceReviewSeverity('warning', 'low')).toBe('medium');
    expect(coerceReviewSeverity('suggestion', 'low')).toBe('low');
    // code-reviewer persona
    expect(coerceReviewSeverity('blocker', 'low')).toBe('critical');
    expect(coerceReviewSeverity('major', 'low')).toBe('high');
    expect(coerceReviewSeverity('minor', 'low')).toBe('medium');
    expect(coerceReviewSeverity('nit', 'low')).toBe('low');
    // spec quality / spec audit
    expect(coerceReviewSeverity('error', 'low')).toBe('high');
    expect(coerceReviewSeverity('warn', 'low')).toBe('medium');
    expect(coerceReviewSeverity('info', 'low')).toBe('low');
    // spec-quality-reviewer persona
    expect(coerceReviewSeverity('blocking', 'low')).toBe('high');
    expect(coerceReviewSeverity('weak', 'low')).toBe('medium');
  });

  it('falls back rather than dropping an unrecognised or absent severity', () => {
    expect(coerceReviewSeverity('showstopper', 'medium')).toBe('medium');
    expect(coerceReviewSeverity(undefined, 'low')).toBe('low');
    expect(coerceReviewSeverity(null, 'low')).toBe('low');
    expect(coerceReviewSeverity(3, 'low')).toBe('low');
  });

  it('never escalates an unknown value onto the blocking tier via the fallback', () => {
    // Callers must not be able to make a typo cost a fix round.
    for (const fallback of ['medium', 'low'] as const) {
      expect(isBlockingSeverity(coerceReviewSeverity('nonsense', fallback))).toBe(false);
    }
  });
});
