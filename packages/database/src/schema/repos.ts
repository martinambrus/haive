import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';
import { tasks } from './tasks.js';
import { envTemplates } from './env.js';
import { customBundles } from './bundles.js';

export const repoSourceEnum = pgEnum('repo_source', [
  'local_path',
  'git_https',
  'github_https',
  'github_oauth',
  'gitlab_https',
  'upload',
]);
export const repoStatusEnum = pgEnum('repo_status', ['cloning', 'ready', 'error']);

// --- Repositories --------------------------------------------------------

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    source: repoSourceEnum('source').notNull(),
    localPath: text('local_path'),
    remoteUrl: text('remote_url'),
    branch: varchar('branch', { length: 255 }).default('main'),
    status: repoStatusEnum('status').notNull().default('ready'),
    statusMessage: text('status_message'),
    detectedFramework: varchar('detected_framework', { length: 64 }),
    detectedLanguages: jsonb('detected_languages').$type<Record<string, number>>(),
    fileTree: jsonb('file_tree').$type<string[]>(),
    excludedPaths: jsonb('excluded_paths').$type<string[]>(),
    selectedPaths: jsonb('selected_paths').$type<string[]>(),
    storagePath: text('storage_path'),
    sizeBytes: integer('size_bytes'),
    credentialsSecretId: uuid('credentials_secret_id').references(() => repoCredentials.id, {
      onDelete: 'set null',
    }),
    /** Snapshot of template_ids that the worker's template manifest expanded
     *  to non-empty renderings against this repo's render context (gating
     *  applied: e.g. drupal-php-lsp items only listed when the user opted into
     *  php-extended LSP). Populated on every onboarding/upgrade/rollback apply.
     *  Null for repos onboarded before this column existed — API treats null
     *  as "use the live row set as the applicable domain". */
    applicableTemplateIds: text('applicable_template_ids').array(),
    /** Writable-local mode: when true, a `local_path` repo's working tree was
     *  copied into the haive_repos volume at import (storage_path points into
     *  the volume) so the workflow can write/commit against a snapshot instead
     *  of the read-only host bind mount. False (default) = reference the host
     *  directory in place, read-only end to end. */
    writable: boolean('writable').notNull().default(false),
    rtkEnabled: boolean('rtk_enabled').notNull().default(true),
    /** Per-repo RTK version pin (bare semver, e.g. "0.42.4"). NULL = use the
     *  Haive default version baked into the composed-image runtime-tools layer.
     *  A set value pins that rtk release for this repo's environment images;
     *  changing it changes the composed-image hash, forcing a rebuild. */
    rtkVersion: text('rtk_version'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('repositories_user_id_idx').on(table.userId),
    index('repositories_status_idx').on(table.status),
  ],
);

export const repoUploads = pgTable(
  'repo_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    branch: varchar('branch', { length: 255 }).default('main'),
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
    index('repo_uploads_user_id_idx').on(table.userId),
    index('repo_uploads_status_idx').on(table.status),
  ],
);

export const repoCredentials = pgTable(
  'repo_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 255 }).notNull(),
    host: varchar('host', { length: 255 }).notNull(),
    usernameEncrypted: text('username_encrypted').notNull(),
    secretEncrypted: text('secret_encrypted').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('repo_credentials_user_id_idx').on(table.userId),
    index('repo_credentials_host_idx').on(table.host),
  ],
);

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  user: one(users, { fields: [repositories.userId], references: [users.id] }),
  credentials: one(repoCredentials, {
    fields: [repositories.credentialsSecretId],
    references: [repoCredentials.id],
  }),
  tasks: many(tasks),
  envTemplates: many(envTemplates),
  customBundles: many(customBundles),
}));

export const repoCredentialsRelations = relations(repoCredentials, ({ one, many }) => ({
  user: one(users, { fields: [repoCredentials.userId], references: [users.id] }),
  repositories: many(repositories),
  customBundles: many(customBundles),
}));

export const repoUploadsRelations = relations(repoUploads, ({ one }) => ({
  user: one(users, { fields: [repoUploads.userId], references: [users.id] }),
}));
