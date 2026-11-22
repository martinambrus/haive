import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import { schema } from '../src/index.js';
it('preserves the nullable execution storage append chain without defaults or backfills', () => {
  for (const [table, predecessor, name, successors] of [
    [
      schema.taskTypeDefinitions,
      'changes',
      'execution_contract',
      ['data_role_bindings', 'selects_own_providers'],
    ],
    [schema.tasks, 'data_edge_plan', 'execution_contract', []],
    [schema.taskSteps, 'provider_wait_provider_id', 'guard_state', []],
  ] as const) {
    const columns = getTableConfig(table).columns;
    const index = columns.findIndex((column) => column.name === name);
    expect(columns.slice(index - 1).map((column) => column.name)).toEqual([
      predecessor,
      name,
      ...successors,
    ]);
    const column = columns[index]!;
    expect([column.name, column.notNull, column.hasDefault, column.getSQLType()]).toEqual([
      name,
      false,
      false,
      'jsonb',
    ]);
  }
});
