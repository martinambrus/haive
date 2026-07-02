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
    /** Onboarding/RAG scope exclusion list: gitignore-style path globs excluded
     *  from the expensive onboarding mining steps (08 knowledge-acquisition,
     *  09-qa, 09_5 skill-generation) and from RAG population / task-end reindex.
     *  DENYLIST semantics: a path NOT listed here is IN scope (including brand-new
     *  folders from later tasks), so new features are auto-mined/indexed; only
     *  listed paths (built-in framework code — Drupal core/contrib, vendor, ...)
     *  are skipped. Seeded during onboarding (06_7) by a deterministic scan of
     *  NO_RECURSE dirs + framework patterns + composer installer-paths + gitignore,
     *  then user-editable via the onboarding picker and the repos-page tree editor.
     *  Agents (06_5-agent-discovery) intentionally ignore this and stay full-repo.
     *  NULL = onboarding has not produced a list yet (the repos-page exclusion
     *  editor stays hidden). Distinct from secretMask* which hides secret files. */
    scopeExcludeGlobs: jsonb('scope_exclude_globs').$type<string[]>(),
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
    /** Per-repo LSP server version pins, keyed by lsp key (intelephense, vtsls,
     *  pyright, gopls, solargraph). Missing entry / null value = latest/unpinned.
     *  Stored repo-level (not only in the env-template declaredDeps, which
     *  01-declare-deps rebuilds each task) so the pins survive env-replicate
     *  re-derivation; 01-declare-deps injects them into declaredDeps so the
     *  Dockerfile render picks them up. */
    lspServerVersions: jsonb('lsp_server_versions').$type<Record<string, string | null>>(),
    /** Per-repo chrome-devtools-mcp version pin (null = latest). Repo-level for
     *  the same survival reason; injected into declaredDeps for the env-image
     *  install line and the operative MCP launcher pin. */
    chromeDevtoolsMcpVersion: text('chrome_devtools_mcp_version'),
    /** Per-repo override of the active LSP server set (env keys, e.g.
     *  intelephense, vtsls, pyright). NULL = no override → 01-declare-deps uses
     *  the form/onboarding-derived set. Set by the tooling management page to
     *  enable/disable LSP servers after onboarding; injected into declaredDeps
     *  so it survives the per-task declare-deps rebuild. */
    lspServers: text('lsp_servers').array(),
    /** Secret-file masking (Tier 1, default on): when true the worker hides
     *  files matching the secret deny-list (DEFAULT_SECRET_DENY_GLOBS ∪
     *  secretMaskDenyExtend, minus carve-outs and secretMaskAllow) from AI CLI
     *  agents by mounting empty read-only files over them in the cli-exec
     *  sandbox. Untracked files only. The running app (ddev/app-runner) still
     *  sees the real files (separate mount, no masks). */
    secretMaskEnabled: boolean('secret_mask_enabled').notNull().default(true),
    /** Per-repo un-mask escape hatch: globs that stay readable to the agent even
     *  if they match a deny glob (e.g. a repo whose tooling genuinely needs the
     *  agent to read a specific env file). */
    secretMaskAllow: jsonb('secret_mask_allow').$type<string[]>().notNull().default([]),
    /** Extra globs to mask on top of the built-in deny-list, for repo-specific
     *  conventions (e.g. `*.sql` when a repo treats SQL files as dumps rather
     *  than schema/migrations). */
    secretMaskDenyExtend: jsonb('secret_mask_deny_extend').$type<string[]>().notNull().default([]),
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
