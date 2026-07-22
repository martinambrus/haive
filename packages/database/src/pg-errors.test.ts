import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from './pg-errors.js';

/** The EXACT shape drizzle-orm throws, captured from a live duplicate insert:
 *  ctor=DrizzleQueryError code=undefined causeCtor=PostgresError causeCode=23505.
 *  The original shallow `err.code === '23505'` check returned false for this, which is
 *  why every "catch 23505 and re-park" dispatch guard was dead code. */
function drizzleWrapped(code: string): Error {
  const driver = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "cli_invocations_one_live_per_step_idx"',
    ),
    { code },
  );
  return Object.assign(new Error('Failed query: insert into "cli_invocations" ...'), {
    cause: driver,
  });
}

describe('isUniqueViolation', () => {
  it('matches a drizzle-wrapped PostgresError (the real production shape)', () => {
    expect(isUniqueViolation(drizzleWrapped('23505'))).toBe(true);
  });

  it('matches a bare driver error that carries the code directly', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('matches when the driver error is nested deeper in the cause chain', () => {
    const inner = drizzleWrapped('23505');
    expect(isUniqueViolation(Object.assign(new Error('outer'), { cause: inner }))).toBe(true);
  });

  it('is false for a different SQLSTATE (e.g. foreign_key_violation)', () => {
    expect(isUniqueViolation(drizzleWrapped('23503'))).toBe(false);
  });

  it('is false for a plain error, a code-less object, null and undefined', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('does not spin on a cyclic cause chain', () => {
    const a: Record<string, unknown> = { message: 'a' };
    const b: Record<string, unknown> = { message: 'b' };
    a.cause = b;
    b.cause = a;
    expect(isUniqueViolation(a)).toBe(false);
  });
});
