import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@haive/database';
import type { SQL } from 'drizzle-orm';
import { loadPreviousStepOutput } from '../src/step-engine/steps/onboarding/_helpers.js';

it('adds a round ceiling only for bounded callers and preserves the projection', async () => {
  const clauses: SQL[] = [];
  const query = {
    from: () => query,
    where: (sql: SQL) => {
      clauses.push(sql);
      return query;
    },
    orderBy: () => query,
    limit: vi.fn(async () => [{ detectOutput: { a: 1 }, output: { b: 2 }, iterations: null }]),
  };
  const db = { select: () => query } as unknown as Database;
  expect(await loadPreviousStepOutput(db, 'task', 'step', 2)).toEqual({
    detect: { a: 1 },
    output: { b: 2 },
    iterations: [],
  });
  await loadPreviousStepOutput(db, 'task', 'step');
  const dialect = new PgDialect();
  const bounded = dialect.sqlToQuery(clauses[0]!);
  const legacy = dialect.sqlToQuery(clauses[1]!);
  expect(bounded.sql).toContain('"round" <= $3');
  expect(bounded.params).toEqual(['task', 'step', 2]);
  expect(legacy.sql).not.toContain('<=');
  expect(legacy.params).toEqual(['task', 'step']);
});
