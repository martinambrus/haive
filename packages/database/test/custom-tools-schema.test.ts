import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/index.js';

describe('custom tool call log', () => {
  it('stores no call arguments or results', () => {
    const { name, columns } = getTableConfig(schema.customToolCalls);

    expect(name).toBe('custom_tool_calls');
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'task_id',
      'task_step_id',
      'cli_invocation_id',
      'step_id',
      'tool',
      'action',
      'outcome',
      'reason',
      'http_status',
      'response_bytes',
      'duration_ms',
      'created_at',
    ]);
  });
});
