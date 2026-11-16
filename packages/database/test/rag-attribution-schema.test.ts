import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { ragQueryLog } from '../src/schema/rag.js';
import { cliInvocations } from '../src/schema/tasks.js';

describe('RAG attribution storage', () => {
  it('appends a nullable invocation with no default or historical backfill', () => {
    const table = getTableConfig(ragQueryLog);
    const column = table.columns.at(-1)!;
    expect(column.name).toBe('cli_invocation_id');
    expect(column.notNull).toBe(false);
    expect(column.hasDefault).toBe(false);
    const reference = table.foreignKeys.find((fk) => fk.reference().columns[0] === column)!;
    expect(reference.reference().foreignTable).toBe(cliInvocations);
    expect(reference.onDelete).toBe('set null');
  });
});
