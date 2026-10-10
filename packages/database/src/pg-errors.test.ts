import { describe, it, expect } from 'vitest';
import {
  hasPgCode,
  isDuplicateDatabase,
  isUniqueViolation,
  isUndefinedTable,
  isActiveSqlTransaction,
} from './pg-errors.js';

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

/** The shape the raw postgres.js driver throws on the RAG search path, captured from the
 *  live api log: a bare PostgresError with the SQLSTATE on the error itself (no drizzle
 *  wrapper, because ragHybridSearch queries through `conn.pg.unsafe`). */
function bareDriverError(code: string): Error {
  return Object.assign(new Error('relation "ai_rag_embeddings" does not exist'), { code });
}

describe('isUndefinedTable', () => {
  it('matches the bare driver error the RAG search path throws', () => {
    expect(isUndefinedTable(bareDriverError('42P01'))).toBe(true);
  });

  it('matches a drizzle-wrapped PostgresError', () => {
    const wrapped = Object.assign(new Error('Failed query: select ...'), {
      cause: bareDriverError('42P01'),
    });
    expect(isUndefinedTable(wrapped)).toBe(true);
  });

  it('is false for a different SQLSTATE (e.g. unique_violation)', () => {
    expect(isUndefinedTable(bareDriverError('23505'))).toBe(false);
    expect(isUniqueViolation(bareDriverError('42P01'))).toBe(false);
  });

  it('is false for a plain error, a code-less object, null and undefined', () => {
    expect(isUndefinedTable(new Error('boom'))).toBe(false);
    expect(isUndefinedTable({})).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
    expect(isUndefinedTable(undefined)).toBe(false);
  });
});

describe('isActiveSqlTransaction', () => {
  // Same captured-shape convention as the tests above: a raw postgres.js error carries the
  // SQLSTATE directly, a drizzle-wrapped one carries it on `.cause`.
  it('matches a raw driver error', () => {
    expect(
      isActiveSqlTransaction({ code: '25001', message: 'cannot run inside a transaction block' }),
    ).toBe(true);
  });

  it('matches through a wrapper', () => {
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: {
        code: '25001',
        message: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
      },
    });
    expect(isActiveSqlTransaction(wrapped)).toBe(true);
  });

  it('does not match a different SQLSTATE', () => {
    expect(isActiveSqlTransaction({ code: '23505' })).toBe(false);
    expect(isActiveSqlTransaction(null)).toBe(false);
  });
});

describe('isDuplicateDatabase', () => {
  const wrapped = (fields: Record<string, unknown>) =>
    Object.assign(new Error('Failed query: CREATE DATABASE "x"'), {
      cause: Object.assign(new Error('driver'), fields),
    });

  it("matches 42P04 and the concurrent create's unique violation of pg_database, wrapped or bare", () => {
    expect(isDuplicateDatabase(wrapped({ code: '42P04' }))).toBe(true);
    expect(
      isDuplicateDatabase(wrapped({ code: '23505', constraint_name: 'pg_database_datname_index' })),
    ).toBe(true);
    expect(isDuplicateDatabase(Object.assign(new Error('x'), { code: '42P04' }))).toBe(true);
  });

  it('refuses any other unique violation and an "already exists" message with another code', () => {
    expect(isDuplicateDatabase(wrapped({ code: '23505', constraint_name: 'other_idx' }))).toBe(
      false,
    );
    expect(isDuplicateDatabase(Object.assign(new Error('already exists'), { code: '42P07' }))).toBe(
      false,
    );
  });
});

describe('hasPgCode', () => {
  it('matches the code on the error, on its cause, and nowhere else', () => {
    const driver = Object.assign(new Error('in use'), { code: '55006' });
    expect(hasPgCode(driver, '55006')).toBe(true);
    expect(hasPgCode(Object.assign(new Error('Failed query'), { cause: driver }), '55006')).toBe(
      true,
    );
    expect(hasPgCode(driver, '40P01')).toBe(false);
    expect(hasPgCode(null, '55006')).toBe(false);
  });

  it('stops on a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(hasPgCode(a, '55006')).toBe(false);
  });
});
