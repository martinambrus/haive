import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth.js';
import { repositories } from './repos.js';
import { tasks } from './tasks.js';
import { customBundleItems } from './bundles.js';

export const artifactSourceEnum = pgEnum('artifact_source', [
  'onboarding',
  'upgrade',
  'rollback',
  'backfill',
]);

// --- Onboarding Artifacts -----------------------------------------------

export const onboardingArtifacts = pgTable(
  'onboarding_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    diskPath: text('disk_path').notNull(),
    templateId: text('template_id').notNull(),
    templateKind: text('template_kind').notNull(),
    templateSchemaVersion: integer('template_schema_version').notNull(),
    templateContentHash: varchar('template_content_hash', { length: 64 }).notNull(),
    writtenHash: varchar('written_hash', { length: 64 }).notNull(),
    /** Actual content the writer placed on disk. Stored verbatim so a
     *  rollback can restore the prior baseline byte-for-byte even when the
     *  template body has drifted in newer Haive code. Null on legacy rows
     *  written before migration 0013. */
    writtenContent: text('written_content'),
    lastObservedDiskHash: varchar('last_observed_disk_hash', { length: 64 }),
    userModified: boolean('user_modified').notNull().default(false),
    formValuesSnapshot: jsonb('form_values_snapshot').$type<Record<string, unknown>>(),
    sourceStepId: varchar('source_step_id', { length: 128 }).notNull(),
    source: artifactSourceEnum('source').notNull().default('onboarding'),
    haiveVersion: varchar('haive_version', { length: 32 }),
    generatedAt: timestamp('generated_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    supersededAt: timestamp('superseded_at'),
    bundleItemId: uuid('bundle_item_id').references(() => customBundleItems.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('onboarding_artifacts_repo_id_idx').on(table.repositoryId),
    index('onboarding_artifacts_task_id_idx').on(table.taskId),
    index('onboarding_artifacts_superseded_idx').on(table.supersededAt),
    index('onboarding_artifacts_bundle_item_idx').on(table.bundleItemId),
    uniqueIndex('onboarding_artifacts_repo_path_live_idx')
      .on(table.repositoryId, table.diskPath)
      .where(sql`superseded_at IS NULL`),
  ],
);

// --- Template Manifest Cache --------------------------------------------

/** Global cache of the worker's compiled template manifest. Synced on worker
 *  boot so the API can answer upgrade-status queries without importing
 *  worker-side generators. Not per-repo — reflects the currently-deployed
 *  worker image's template set. */
export const templateManifestCache = pgTable('template_manifest_cache', {
  templateId: varchar('template_id', { length: 128 }).primaryKey(),
  templateKind: text('template_kind').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  setHash: varchar('set_hash', { length: 64 }).notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const onboardingArtifactsRelations = relations(onboardingArtifacts, ({ one }) => ({
  user: one(users, { fields: [onboardingArtifacts.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [onboardingArtifacts.repositoryId],
    references: [repositories.id],
  }),
  task: one(tasks, { fields: [onboardingArtifacts.taskId], references: [tasks.id] }),
  bundleItem: one(customBundleItems, {
    fields: [onboardingArtifacts.bundleItemId],
    references: [customBundleItems.id],
  }),
}));
