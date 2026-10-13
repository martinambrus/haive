import { pgTable, text, varchar, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';

/** Refreshed by the worker at every boot; `composable` and `entry` come from the code-owned core catalog and module manifests. */
export const stepCatalog = pgTable('step_catalog', {
  stepId: varchar('step_id', { length: 256 }).primaryKey(),
  source: varchar('source', { length: 128 }).notNull(),
  title: text('title').notNull(),
  workflowType: varchar('workflow_type', { length: 128 }).notNull(),
  dispatchesCli: boolean('dispatches_cli').notNull(),
  allowSkip: boolean('allow_skip').notNull(),
  providerSensitive: boolean('provider_sensitive').notNull(),
  cliRoles: jsonb('cli_roles'),
  composable: boolean('composable').notNull().default(false),
  entry: jsonb('entry'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
