import { expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { pricedCostRowSql } from '../src/stats-server/cost.js';

it('recognizes priced snapshots and legacy reported costs, including recorded zero', () => {
  const { sql, params } = new PgDialect().sqlToQuery(pricedCostRowSql());
  expect(sql).toContain("->> 'source' <> 'none'");
  expect(sql).toContain("->> 'costUsd' is not null");
  expect(sql).toContain('"cli_providers"."auth_mode"');
  expect(params).toContain('claude-code');
});
