import { pgTable, pgEnum, uuid, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tasks, taskSteps, cliInvocations } from './tasks.js';

export const customToolCallOutcomeEnum = pgEnum('custom_tool_call_outcome', [
  'ok',
  'refused',
  'error',
  'running',
]);

// Never holds an argument or a result: both carry repository or user data.
export const customToolCalls = pgTable(
  'custom_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    cliInvocationId: uuid('cli_invocation_id').references(() => cliInvocations.id, {
      onDelete: 'set null',
    }),
    stepId: varchar('step_id', { length: 128 }).notNull(),
    tool: varchar('tool', { length: 64 }).notNull(),
    action: varchar('action', { length: 32 }).notNull(),
    outcome: customToolCallOutcomeEnum('outcome').notNull(),
    reason: varchar('reason', { length: 64 }),
    httpStatus: integer('http_status'),
    responseBytes: integer('response_bytes'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('custom_tool_calls_cli_invocation_id_idx').on(table.cliInvocationId),
    index('custom_tool_calls_task_id_created_at_idx').on(table.taskId, table.createdAt),
  ],
);
