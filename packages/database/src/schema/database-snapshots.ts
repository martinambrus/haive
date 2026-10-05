import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { repositories } from './repos.js';
import { tasks, taskSteps } from './tasks.js';

/** Inventory survives repository deletion so the worker can remove the files afterwards. */
export const databaseSnapshots = pgTable(
  'database_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id').notNull(),
    userId: uuid('user_id').notNull(),
    sourceTaskId: uuid('source_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    sourceTaskTitle: text('source_task_title').notNull(),
    parentSnapshotId: uuid('parent_snapshot_id'),
    status: text('status').notNull().default('writing'),
    engine: text('engine').notNull(),
    engineVersion: text('engine_version'),
    codeCommit: text('code_commit'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('database_snapshots_repository_idx').on(t.repositoryId)],
);

export const repositoryDatabaseStates = pgTable('repository_database_states', {
  repositoryId: uuid('repository_id')
    .primaryKey()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(0),
  snapshotId: uuid('snapshot_id').references(() => databaseSnapshots.id, { onDelete: 'set null' }),
});

export const taskDatabaseStates = pgTable('task_database_states', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  repositoryId: uuid('repository_id')
    .notNull()
    .references(() => repositories.id, { onDelete: 'cascade' }),
  baseRevision: integer('base_revision').notNull(),
  sourceSnapshotId: uuid('source_snapshot_id').references(() => databaseSnapshots.id, {
    onDelete: 'set null',
  }),
  saveEnabled: boolean('save_enabled').notNull().default(true),
  candidateSnapshotId: uuid('candidate_snapshot_id').references(() => databaseSnapshots.id, {
    onDelete: 'set null',
  }),
  outcome: text('outcome').notNull().default('pending'),
  importedAt: timestamp('imported_at'),
  exportError: text('export_error'),
  decisionEpoch: integer('decision_epoch'),
  candidateStepId: uuid('candidate_step_id').references(() => taskSteps.id, {
    onDelete: 'set null',
  }),
});
