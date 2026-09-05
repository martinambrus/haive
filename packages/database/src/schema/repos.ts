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
  // Greenfield: no remote and no local tree. The repo-queue INIT job creates the
  // storage dir, `git init`s it and lands one commit, so every downstream
  // resolver (worktrees, mounts, the .haive-data mirror) sees a normal repo.
  'blank',
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
    /** Repo-level RAG scope exclusion list: gitignore-style path globs excluded
     *  from RAG population (onboarding 10-rag-populate) and task-end reindex
     *  (02-pre-rag-sync / 11c-rag-reindex). DENYLIST semantics: a path NOT listed
     *  here is IN scope (including brand-new folders from later tasks), so new
     *  features are auto-indexed; only listed paths (built-in framework code —
     *  Drupal core/contrib, vendor, ...) are skipped. Chosen during onboarding at
     *  the 09_7-rag-source-selection step (seeded from the mining pick / framework
     *  patterns) and user-editable later via the repos-page tree editor. This is
     *  the RAG scope ONLY — the KB + skill mining scope (08/09-qa/09_5/09_5b) is
     *  task-local, kept in 06_7's step output, and is NOT stored here. NULL =
     *  onboarding has not produced a list yet (the repos-page editor stays hidden).
     *  Distinct from secretMask* which hides secret files. */
    scopeExcludeGlobs: jsonb('scope_exclude_globs').$type<string[]>(),
    /** Repo-level snapshot of the onboarding-derived ENVIRONMENT (raw 01-env-detect
     *  `.data` + 02-detection-confirmation confirmed values), so a workflow task can
     *  resolve the repo's stack WITHOUT looking up the onboarding task's step
     *  outputs — which don't exist after a fresh clone on another machine. Written
     *  by 02-detection-confirmation.apply, restored on clone from
     *  `.haive-data/environment.json`. Shape = @haive/shared OnboardingEnvironmentMirror
     *  (kept loose here to avoid a database->shared import cycle). NULL = not onboarded
     *  (consumers fall back to the onboarding-task lookup). */
    onboardingEnvironment: jsonb('onboarding_environment').$type<Record<string, unknown>>(),
    /** Repo-level snapshot of the onboarding-derived TOOLING prefs (the
     *  04-tooling-infrastructure `output.tooling`: ragMode, embeddingModel, etc. —
     *  incl. machine-specific infra like ollamaUrl for LOCAL use). Written by
     *  04-tooling-infrastructure.apply, restored on clone from `.haive-data/tooling.json`
     *  MINUS the infra keys (those don't travel between machines). Shape =
     *  @haive/shared OnboardingToolingMirror. NULL = fall back to the onboarding-task
     *  04-tooling output lookup. */
    onboardingTooling: jsonb('onboarding_tooling').$type<Record<string, unknown>>(),
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
    /** Per-repo enable for the pull-request close-out workflow: when true (and the
     *  global CONFIG_KEYS.PR_WORKFLOW_ENABLED is on), the 12-worktree-cleanup step
     *  offers the create_pr action for this repo. Default TRUE — the global switch is
     *  the real gate (staged rollout, default off), so per-repo is an opt-OUT: once an
     *  admin enables the feature globally, every eligible repo (origin remote + a
     *  credential with a forge provider) surfaces the option without the user having to
     *  find the tooling-page toggle. Turn it off per repo to suppress the option there. */
    prWorkflowEnabled: boolean('pr_workflow_enabled').notNull().default(true),
    /** Per-repo opt-OUT for learned step guidance. When true (and the global
     *  CONFIG_KEYS.STEP_GUIDANCE_ENABLED is on), approved guidance items for this
     *  repo are appended to the relevant step prompts, and 11e-prompt-guidance
     *  offers new candidates at the end of a run. Default TRUE for the same reason
     *  as prWorkflowEnabled above: the global switch is the real gate (staged
     *  rollout, default off), so per-repo exists to silence one noisy repo without
     *  turning the feature off everywhere. */
    stepGuidanceEnabled: boolean('step_guidance_enabled').notNull().default(true),
    /** Per-repo review-dimension policy: the ids (see REVIEW_DIMENSIONS in
     *  @haive/shared/review) the reviewing steps score a change against.
     *  NULL = no override, i.e. every dimension — which is what every row held
     *  before the setting existed and what the reviewers did. Nullable rather
     *  than notNull-with-a-default for that reason: `[]` (score nothing) and
     *  "never chosen" must stay distinguishable, same as lspServers above.
     *  A task may narrow this further via tasks.review_dimensions, but only for
     *  the REVIEW steps — discovery (03) and the spec writer (04) run before the
     *  run-config form and follow this repo-level value. */
    reviewDimensions: text('review_dimensions').array(),
    /** When an embedding call failed against a RAG index that already holds real
     *  vectors. NULL = healthy. This is the STRUCTURAL column every reader gates
     *  on — `ragEmbedDegradedReason` beside it is display copy that outlives the
     *  state it describes (see the message-column rule in AGENTS.md), so a banner
     *  keyed on the text alone would render a phantom failure after a repair.
     *  Set by the ingest steps via `_rag-embed-health.ts`, cleared by a retry. */
    ragEmbedDegradedAt: timestamp('rag_embed_degraded_at'),
    /** Why it degraded, in the words shown to the user. Nothing branches on it. */
    ragEmbedDegradedReason: text('rag_embed_degraded_reason'),
    /** The user's accepted verdict: run this repo's RAG on lexical search alone.
     *  Hash vectors are not a neutral fallback — they are noise in the dense half
     *  of the RRF fusion and can outrank a genuine lexical hit — so "accept the
     *  degradation" forces `ragHybridSearch`'s existing lexical-only branch rather
     *  than embedding a query into a space the stored rows do not share. */
    ragEmbedLexicalOnly: boolean('rag_embed_lexical_only').notNull().default(false),
    /** Deterministic form login for browser testing (default: absent = disabled).
     *
     *  Holds only the SHAPE of the login — where it is and how to recognise success.
     *  The username and password live in user_secrets under `app_auth:<repoId>:*`,
     *  because this row is read into prompts and step outputs all over the codebase
     *  and a credential in it would leak by a dozen routes.
     *
     *  Selector-based rather than natural language on purpose: the login runs in
     *  browser-login.js inside the runner, with no model involved, which is the only
     *  way the credentials never reach a CLI provider's context. */
    appAuth: jsonb('app_auth').$type<{
      enabled: boolean;
      loginUrl: string;
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
      successCondition: { type: 'url_contains' | 'element_present'; value: string };
    } | null>(),
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
    /** Optional commit identity for every repository bound to this credential.
     *  Overrides the user's global `users.git_name`/`users.git_email`. Set both or
     *  neither — a half-filled pair is rejected at the API and ignored by
     *  resolveGitEnv, so a commit can never be authored `Work Name <personal@email>`.
     *  Plaintext like the user-level columns: these are stamped into every commit
     *  object and pushed to the remote, so they are not secrets. */
    gitName: text('git_name'),
    gitEmail: text('git_email'),
    /** Which forge this credential authenticates against, selecting the PR/MR REST
     *  client used at task close (github | gitea | gitlab | bitbucket_cloud |
     *  bitbucket_server; see @haive/shared forgeProviderSchema). NULL = git-over-HTTPS
     *  only, no PR creation. Stored explicitly because a hostname cannot reveal the
     *  forge software for self-hosted installs. */
    provider: varchar('provider', { length: 32 }),
    /** Optional override for the forge REST API base URL, for self-hosted installs
     *  where the per-provider convention (<host>/api/v1, /api/v4, ...) does not hold
     *  (subpath / reverse-proxy deployments). NULL = derive from host + provider. */
    apiBaseUrl: text('api_base_url'),
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
