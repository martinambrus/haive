import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';

export const runListStrategyEnum = pgEnum('run_list_strategy', [
  'static',
  'workflow_paths',
  'run_app_modes',
]);

export const taskTypeDefinitions = pgTable('task_type_definitions', {
  slug: varchar('slug', { length: 128 }).primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  runListStrategy: runListStrategyEnum('run_list_strategy').notNull(),
  stepIds: jsonb('step_ids').$type<string[]>(),
  preAnswerDefaults: jsonb('pre_answer_defaults')
    .$type<Record<string, Record<string, unknown>>>()
    .notNull()
    .default({}),
  stepLoopLimitDefaults: jsonb('step_loop_limit_defaults')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  fixLoop: jsonb('fix_loop').$type<{
    targetStepId: string;
    humanRejectSourceStepIds: string[];
    honoredConstraintSourceStepIds: string[];
  }>(),
  enabled: boolean('enabled').notNull().default(true),
  selectable: boolean('selectable').notNull().default(true),
  source: varchar('source', { length: 128 }).notNull(),
  requiresRepository: boolean('requires_repository').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  contentHash: varchar('content_hash', { length: 64 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
