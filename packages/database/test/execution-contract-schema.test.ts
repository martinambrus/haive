import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'vitest';
import { schema } from '../src/index.js';
it('appends nullable execution storage last without defaults or backfills', () => {
  for (const [table, name] of [
    [schema.taskTypeDefinitions, 'execution_contract'],
    [schema.tasks, 'execution_contract'],
    [schema.taskSteps, 'guard_state'],
  ] as const) {
    const column = getTableConfig(table).columns.at(-1)!;
    expect([column.name, column.notNull, column.hasDefault, column.getSQLType()]).toEqual([
      name,
      false,
      false,
      'jsonb',
    ]);
  }
});
