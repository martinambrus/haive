import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const runListStrategyEnum = pgEnum('run_list_strategy', [
  'static',
  'workflow_paths',
  'run_app_modes',
  'derived',
]);

export const taskTypeDefinitions = pgTable(
  'task_type_definitions',
  {
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
    /** Step slug to prompt step entry. Only an admin row carries any. Migration 0200. */
    promptSteps: jsonb('prompt_steps').$type<Record<string, unknown>>().notNull().default({}),
    /** Storage only. Shared depends on database, so importing its overlay type would create a cycle. */
    baseSlug: varchar('base_slug', { length: 128 }),
    changes: jsonb('changes').$type<unknown>(),
  },
  (table) => [
    check(
      'task_type_definitions_derived_shape_check',
      sql`${table.runListStrategy} <> 'derived' OR (
    ${table.baseSlug} IS NOT NULL AND ${table.changes} IS NOT NULL AND ${table.stepIds} IS NULL
    AND ${table.source} = 'admin' AND jsonb_typeof(${table.changes}) = 'array'
  )`,
    ),
    check(
      'task_type_definitions_non_derived_shape_check',
      sql`${table.runListStrategy} = 'derived' OR (${table.baseSlug} IS NULL AND ${table.changes} IS NULL)`,
    ),
    check(
      'task_type_definitions_base_not_self_check',
      sql`${table.baseSlug} IS NULL OR ${table.baseSlug} <> ${table.slug}`,
    ),
    foreignKey({
      name: 'task_type_definitions_base_slug_task_type_definitions_slug_fk',
      columns: [table.baseSlug],
      foreignColumns: [table.slug],
    })
      .onDelete('restrict')
      .onUpdate('no action'),
  ],
);
