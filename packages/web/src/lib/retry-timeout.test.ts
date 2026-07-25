import { describe, expect, it } from 'vitest';
import {
  defaultRetryTimeoutMinutes,
  parseRetryTimeoutMinutes,
  RETRY_TIMEOUT_MAX_MINUTES,
  RETRY_TIMEOUT_MIN_MINUTES,
} from './retry-timeout';

describe('defaultRetryTimeoutMinutes', () => {
  it('offers at least 120 for the default ladder rungs', () => {
    expect(defaultRetryTimeoutMinutes(45)).toBe(120);
    expect(defaultRetryTimeoutMinutes(60)).toBe(120);
    // Doubling wins once it clears the 120 floor.
    expect(defaultRetryTimeoutMinutes(90)).toBe(180);
  });

  it('never proposes less than the budget that already failed', () => {
    // A step declaring 90m escalates to 180m; pre-filling 120 there would offer LESS
    // time than the run that just timed out.
    expect(defaultRetryTimeoutMinutes(180)).toBe(360);
    expect(defaultRetryTimeoutMinutes(120)).toBe(240);
  });

  it('never proposes more than the server will accept', () => {
    expect(defaultRetryTimeoutMinutes(400)).toBe(RETRY_TIMEOUT_MAX_MINUTES);
  });

  it('falls back to 120 for a nonsense last budget', () => {
    expect(defaultRetryTimeoutMinutes(Number.NaN)).toBe(120);
    expect(defaultRetryTimeoutMinutes(0)).toBe(120);
  });
});

describe('parseRetryTimeoutMinutes', () => {
  it('accepts a plain number', () => {
    expect(parseRetryTimeoutMinutes('120')).toBe(120);
    expect(parseRetryTimeoutMinutes('  90 ')).toBe(90);
  });

  it('rounds a fractional entry to whole minutes', () => {
    expect(parseRetryTimeoutMinutes('90.6')).toBe(91);
  });

  it('clamps out-of-range values instead of rejecting them', () => {
    expect(parseRetryTimeoutMinutes('5')).toBe(RETRY_TIMEOUT_MIN_MINUTES);
    expect(parseRetryTimeoutMinutes('9999')).toBe(RETRY_TIMEOUT_MAX_MINUTES);
    expect(parseRetryTimeoutMinutes('-30')).toBe(RETRY_TIMEOUT_MIN_MINUTES);
  });

  it('returns null for a cancelled or empty prompt', () => {
    // prompt() gives null on Cancel — that must not fall through to a retry.
    expect(parseRetryTimeoutMinutes(null)).toBeNull();
    expect(parseRetryTimeoutMinutes('')).toBeNull();
    expect(parseRetryTimeoutMinutes('   ')).toBeNull();
  });

  it('returns null for text that is not a number', () => {
    expect(parseRetryTimeoutMinutes('two hours')).toBeNull();
    expect(parseRetryTimeoutMinutes('120m')).toBeNull();
  });
});
