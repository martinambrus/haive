import { describe, expect, it } from 'vitest';
import { isRefusedStatement, isUniqueViolationOf } from '../src/pg-errors.js';

const INDEX = 'tasks_one_live_upgrade_per_repo_idx';

describe('isUniqueViolationOf', () => {
  it('finds the named index under the wrapper drizzle throws', () => {
    const driver = { code: '23505', constraint_name: INDEX };
    expect(isUniqueViolationOf(new Error('query failed', { cause: driver }), INDEX)).toBe(true);
  });

  it('ignores another index and another error code', () => {
    expect(isUniqueViolationOf({ cause: { code: '23505', constraint_name: 'x' } }, INDEX)).toBe(
      false,
    );
    expect(isUniqueViolationOf({ code: '23503', constraint_name: INDEX }, INDEX)).toBe(false);
    expect(isUniqueViolationOf(null, INDEX)).toBe(false);
  });
});

describe('isRefusedStatement', () => {
  const pg = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
  const drizzle = (cause: unknown) => Object.assign(new Error('Failed query'), { cause });

  it('is true for a statement Postgres refused, bare or wrapped by drizzle', () => {
    for (const code of [
      '23505',
      '22001',
      '42P01',
      '25P02',
      '40001',
      '40P01',
      '55P03',
      '53100',
      '0A000',
    ]) {
      expect(isRefusedStatement(pg(code))).toBe(true);
      expect(isRefusedStatement(drizzle(pg(code)))).toBe(true);
    }
  });

  it('is false when the outcome is unknown', () => {
    for (const code of ['08006', '08003', '57P01', '40003', 'XX000', '58030']) {
      expect(isRefusedStatement(pg(code))).toBe(false);
    }
    expect(
      isRefusedStatement(Object.assign(new Error('closed'), { code: 'CONNECTION_CLOSED' })),
    ).toBe(false);
    expect(isRefusedStatement(new Error('socket hang up'))).toBe(false);
    expect(isRefusedStatement(undefined)).toBe(false);
  });
});
