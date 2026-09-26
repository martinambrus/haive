import { describe, expect, it } from 'vitest';
import { isUniqueViolationOf } from '../src/pg-errors.js';

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
