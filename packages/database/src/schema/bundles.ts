import {
  pgTable,
  uuid,
  text,
  varchar,
  bigint,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth.js';
import { repositories, repoCredentials } from './repos.js';
import { onboardingArtifacts } from './onboarding.js';

export const customBundleSourceTypeEnum = pgEnum('custom_bundle_source_type', ['zip', 'git']);
export const customBundleStatusEnum = pgEnum('custom_bundle_status', [
  'active',
  'syncing',
  'failed',
]);
export const customBundleItemKindEnum = pgEnum('custom_bundle_item_kind', ['agent', 'skill']);
export const customBundleItemSourceFormatEnum = pgEnum('custom_bundle_item_source_format', [
  'claude-md',
  'codex-toml',
  'gemini-md',
]);

// --- Custom Bundles -----------------------------------------------------

/** Per-repo registry of user-supplied bundle sources (ZIP/TAR uploads or
 *  git clones) that ship custom agent and skill definitions. Ingested during
 *  onboarding (step 06_3-custom-bundles); resynced via 00-bundle-resync on
 *  upgrade. Items derived from a bundle live in `custom_bundle_items` and
 *  are projected onto disk through the existing `onboarding_artifacts`
 *  lifecycle so they share the upgrade-plan / rollback machinery. */
export const customBundles = pgTable(
  'custom_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    sourceType: customBundleSourceTypeEnum('source_type').notNull(),
    archiveFilename: text('archive_filename'),
    archivePath: text('archive_path'),
    archiveFormat: varchar('archive_format', { length: 16 }),
    gitUrl: text('git_url'),
    gitBranch: varchar('git_branch', { length: 255 }),
    gitCredentialsId: uuid('git_credentials_id').references(() => repoCredentials.id, {
      onDelete: 'set null',
    }),
    storageRoot: text('storage_root').notNull(),
    enabledKinds: text('enabled_kinds')
      .array()
      .notNull()
      .default(sql`ARRAY['agent','skill']::text[]`),
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncCommit: varchar('last_sync_commit', { length: 40 }),
    lastSyncError: text('last_sync_error'),
    status: customBundleStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('custom_bundles_repository_id_idx').on(table.repositoryId),
    index('custom_bundles_user_repo_idx').on(table.userId, table.repositoryId),
  ],
);

/** Chunked/resumable upload sessions for ZIP/TAR bundle archives. Mirrors the
 *  repo_uploads pattern. `bundle_id` is null until complete, when the upload
 *  is rolled into a `custom_bundles` row using the per-session bundle
 *  metadata stored on the upload row. */
export const customBundleUploads = pgTable(
  'custom_bundle_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bundleId: uuid('bundle_id').references(() => customBundles.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    enabledKinds: text('enabled_kinds')
      .array()
      .notNull()
      .default(sql`ARRAY['agent','skill']::text[]`),
    filename: text('filename').notNull(),
    archiveFormat: varchar('archive_format', { length: 16 }).notNull(),
    totalSize: bigint('total_size', { mode: 'number' }).notNull(),
    bytesReceived: bigint('bytes_received', { mode: 'number' }).notNull().default(0),
    chunkSize: integer('chunk_size').notNull(),
    archivePath: text('archive_path').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('uploading'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('custom_bundle_uploads_user_id_idx').on(table.userId),
    index('custom_bundle_uploads_status_idx').on(table.status),
  ],
);

/** Parsed catalog of agent/skill items extracted from a bundle. Each row
 *  carries the canonical IR (`AgentSpec` or `SkillEntry`) plus a content
 *  hash so changes flow through the upgrade buckets exactly like Haive
 *  template items. */
export const customBundleItems = pgTable(
  'custom_bundle_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bundleId: uuid('bundle_id')
      .notNull()
      .references(() => customBundles.id, { onDelete: 'cascade' }),
    kind: customBundleItemKindEnum('kind').notNull(),
    sourceFormat: customBundleItemSourceFormatEnum('source_format').notNull(),
    sourcePath: text('source_path').notNull(),
    normalizedSpec: jsonb('normalized_spec').$type<Record<string, unknown>>().notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('custom_bundle_items_bundle_path_idx').on(table.bundleId, table.sourcePath),
    index('custom_bundle_items_bundle_kind_idx').on(table.bundleId, table.kind),
  ],
);

export const customBundlesRelations = relations(customBundles, ({ one, many }) => ({
  user: one(users, { fields: [customBundles.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [customBundles.repositoryId],
    references: [repositories.id],
  }),
  credentials: one(repoCredentials, {
    fields: [customBundles.gitCredentialsId],
    references: [repoCredentials.id],
  }),
  items: many(customBundleItems),
  uploads: many(customBundleUploads),
}));

export const customBundleUploadsRelations = relations(customBundleUploads, ({ one }) => ({
  user: one(users, { fields: [customBundleUploads.userId], references: [users.id] }),
  bundle: one(customBundles, {
    fields: [customBundleUploads.bundleId],
    references: [customBundles.id],
  }),
}));

export const customBundleItemsRelations = relations(customBundleItems, ({ one, many }) => ({
  bundle: one(customBundles, {
    fields: [customBundleItems.bundleId],
    references: [customBundles.id],
  }),
  artifacts: many(onboardingArtifacts),
}));
