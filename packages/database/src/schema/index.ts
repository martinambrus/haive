import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Structured hint payload stored in `task_steps.error_hint`. Mirror of the
 * `StepErrorHint` union in `@haive/shared`; duplicated here to keep
 * `@haive/database` free of a reverse dependency on shared (shared already
 * depends on database via the secrets services).
 */
type TaskStepErrorHint = { type: 'cli_login_required'; providerId: string; providerName: string };

// --- Enums --------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', ['admin', 'user']);
export const userStatusEnum = pgEnum('user_status', ['active', 'deactivated']);

export const cliProviderNameEnum = pgEnum('cli_provider_name', [
  'claude-code',
  'codex',
  'gemini',
  'amp',
  'zai',
]);
export const cliAuthModeEnum = pgEnum('cli_auth_mode', ['subscription', 'api_key']);
export const cliSandboxBuildStatusEnum = pgEnum('cli_sandbox_build_status', [
  'idle',
  'building',
  'ready',
  'failed',
]);
export const cliInvocationModeEnum = pgEnum('cli_invocation_mode', [
  'cli',
  'subagent_emulated',
  'agent_mining',
]);

export const repoSourceEnum = pgEnum('repo_source', [
  'local_path',
  'git_https',
  'github_https',
  'github_oauth',
  'gitlab_https',
  'upload',
]);
export const repoStatusEnum = pgEnum('repo_status', ['cloning', 'ready', 'error']);

// 'env_replicate' kept in pgEnum for backward compat with existing DB rows.
// It is no longer a user-facing type — env-replicate steps run as a mandatory
// prelude for workflow tasks. The TS WorkflowType union enforces 'onboarding' | 'workflow'.
export const workflowTypeEnum = pgEnum('workflow_type', [
  'onboarding',
  'workflow',
  'env_replicate',
  'onboarding_upgrade',
]);
export const taskStatusEnum = pgEnum('task_status', [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
]);
export const stepStatusEnum = pgEnum('step_status', [
  'pending',
  'running',
  'waiting_form',
  'waiting_cli',
  'done',
  'failed',
  'skipped',
]);

export const agentMiningStatusEnum = pgEnum('agent_mining_status', [
  'pending',
  'running',
  'done',
  'failed',
]);

export const containerRuntimeEnum = pgEnum('container_runtime', ['clawker', 'dockerode']);
export const containerStatusEnum = pgEnum('container_status', [
  'creating',
  'running',
  'stopped',
  'destroyed',
  'error',
]);
export const containerPurposeEnum = pgEnum('container_purpose', ['task', 'cli_login']);

export const cliAuthStatusEnum = pgEnum('cli_auth_status', [
  'unknown',
  'ok',
  'auth_expired',
  'auth_denied',
  'rate_limited',
  'network_error',
  'timeout',
  'unknown_error',
]);

export const envTemplateStatusEnum = pgEnum('env_template_status', [
  'pending',
  'building',
  'ready',
  'failed',
]);

export const artifactSourceEnum = pgEnum('artifact_source', [
  'onboarding',
  'upgrade',
  'rollback',
  'backfill',
]);

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

// --- Auth ---------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailEncrypted: text('email_encrypted').notNull(),
    emailBlindIndex: varchar('email_blind_index', { length: 64 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name'),
    phoneEncrypted: text('phone_encrypted'),
    gitName: text('git_name'),
    gitEmail: text('git_email'),
    role: userRoleEnum('role').notNull().default('user'),
    status: userStatusEnum('status').notNull().default('active'),
    tokenVersion: integer('token_version').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_blind_index_idx').on(table.emailBlindIndex)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('refresh_tokens_user_id_idx').on(table.userId)],
);

// System-wide secrets (single-key encryption with master KEK).
export const systemSecrets = pgTable(
  'system_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 255 }).notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('system_secrets_key_idx').on(table.key)],
);

// Per-user secrets (envelope encryption: per-user DEK encrypts the value,
// master KEK encrypts the DEK).
export const userSecrets = pgTable(
  'user_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyName: varchar('key_name', { length: 255 }).notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }),
    description: text('description'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('user_secrets_user_id_idx').on(table.userId),
    uniqueIndex('user_secrets_user_key_idx').on(table.userId, table.keyName),
  ],
);

// --- CLI Providers -------------------------------------------------------

export const cliProviders = pgTable(
  'cli_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: cliProviderNameEnum('name').notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    executablePath: text('executable_path'),
    wrapperPath: text('wrapper_path'),
    wrapperContent: text('wrapper_content'),
    envVars: jsonb('env_vars').$type<Record<string, string>>(),
    cliArgs: jsonb('cli_args').$type<string[]>(),
    supportsSubagents: boolean('supports_subagents').notNull().default(false),
    networkPolicy: jsonb('network_policy')
      .$type<{ mode: 'none' | 'full' | 'allowlist'; domains: string[]; ips: string[] }>()
      .notNull()
      .default({ mode: 'full', domains: [], ips: [] }),
    authMode: cliAuthModeEnum('auth_mode').notNull().default('subscription'),
    cliVersion: text('cli_version'),
    effortLevel: text('effort_level'),
    sandboxDockerfileExtra: text('sandbox_dockerfile_extra'),
    sandboxImageTag: text('sandbox_image_tag'),
    sandboxImageBuildStatus: cliSandboxBuildStatusEnum('sandbox_image_build_status')
      .notNull()
      .default('idle'),
    sandboxImageBuildError: text('sandbox_image_build_error'),
    sandboxImageBuiltAt: timestamp('sandbox_image_built_at'),
    enabled: boolean('enabled').notNull().default(true),
    isolateAuth: boolean('isolate_auth').notNull().default(false),
    authStatus: cliAuthStatusEnum('auth_status').notNull().default('unknown'),
    authLastCheckedAt: timestamp('auth_last_checked_at'),
    authMessage: text('auth_message'),
    rulesContent: text('rules_content').notNull().default(''),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('cli_providers_user_id_idx').on(table.userId)],
);

export const cliProviderSecrets = pgTable(
  'cli_provider_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => cliProviders.id, { onDelete: 'cascade' }),
    secretName: varchar('secret_name', { length: 255 }).notNull(),
    encryptedValue: text('encrypted_value').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('cli_provider_secrets_provider_id_idx').on(table.providerId),
    uniqueIndex('cli_provider_secrets_provider_name_idx').on(table.providerId, table.secretName),
  ],
);

export const cliPackageVersions = pgTable('cli_package_versions', {
  name: cliProviderNameEnum('name').primaryKey(),
  versions: jsonb('versions').$type<string[]>().notNull().default([]),
  latestVersion: text('latest_version'),
  fetchedAt: timestamp('fetched_at'),
  fetchError: text('fetch_error'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

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
    rtkEnabled: boolean('rtk_enabled').notNull().default(true),
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

// --- Tasks ---------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    envTemplateId: uuid('env_template_id').references(() => envTemplates.id, {
      onDelete: 'set null',
    }),
    type: workflowTypeEnum('type').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('created'),
    currentStepId: varchar('current_step_id', { length: 128 }),
    currentStepIndex: doublePrecision('current_step_index').notNull().default(0),
    containerId: varchar('container_id', { length: 255 }),
    worktreePath: text('worktree_path'),
    memoryLimitMb: integer('memory_limit_mb'),
    cpuLimitMilli: integer('cpu_limit_milli'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /** Per-task overrides for the maximum loop iterations a step can run.
     *  Map of stepId → maxIterations. The runner reads this when a step
     *  declares a loop hook and falls back to the loopSpec default when
     *  the step id is absent. Lets the new-task form pick a budget per
     *  loop step (e.g. spec-quality 5 instead of the default 10). */
    stepLoopLimits: jsonb('step_loop_limits')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('tasks_user_id_idx').on(table.userId),
    index('tasks_status_idx').on(table.status),
    index('tasks_repository_id_idx').on(table.repositoryId),
    index('tasks_env_template_id_idx').on(table.envTemplateId),
  ],
);

export const taskSteps = pgTable(
  'task_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: varchar('step_id', { length: 128 }).notNull(),
    stepIndex: doublePrecision('step_index').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    detectOutput: jsonb('detect_output').$type<unknown>(),
    formSchema: jsonb('form_schema').$type<unknown>(),
    formValues: jsonb('form_values').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<unknown>(),
    /** Append-only history of every loop pass this step ran. Each entry
     *  records the LLM output (if any), the apply output, and whether the
     *  loop should still continue after that pass. Empty array on steps
     *  that don't declare a loop hook. */
    iterations: jsonb('iterations')
      .$type<StepIterationEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Mirror of jsonb_array_length(iterations) so the runner can branch
     *  on iteration count without parsing the JSONB blob. */
    iterationCount: integer('iteration_count').notNull().default(0),
    statusMessage: text('status_message'),
    errorMessage: text('error_message'),
    errorHint: jsonb('error_hint').$type<TaskStepErrorHint>(),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_steps_task_id_idx').on(table.taskId),
    uniqueIndex('task_steps_task_step_idx').on(table.taskId, table.stepId),
  ],
);

export interface StepIterationEntry {
  iteration: number;
  llmOutput: unknown;
  applyOutput: unknown;
  /** True when the loop's shouldContinue predicate was still true after
   *  this pass — meaning another pass would have run if budget remained.
   *  False on the final pass (either shouldContinue returned false or the
   *  iteration budget was exhausted). */
  continueRequested: boolean;
  /** Set on the LAST iteration when shouldContinue was still true but no
   *  more passes were attempted because the iteration budget was hit. The
   *  user-facing gate uses this to flag "loop budget exhausted, spec may
   *  still have findings". */
  exhaustedBudget?: boolean;
  recordedAt: string;
}

export const taskEvents = pgTable(
  'task_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_events_task_id_idx').on(table.taskId),
    index('task_events_event_type_idx').on(table.eventType),
  ],
);

export const taskUserInputs = pgTable(
  'task_user_inputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskStepId: uuid('task_step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),
    questionId: varchar('question_id', { length: 128 }).notNull(),
    answerType: varchar('answer_type', { length: 32 }).notNull(),
    answerValue: jsonb('answer_value').$type<unknown>(),
    answeredAt: timestamp('answered_at').notNull().defaultNow(),
  },
  (table) => [index('task_user_inputs_task_step_id_idx').on(table.taskStepId)],
);

export const taskStepAgentMinings = pgTable(
  'task_step_agent_minings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskStepId: uuid('task_step_id')
      .notNull()
      .references(() => taskSteps.id, { onDelete: 'cascade' }),
    agentId: varchar('agent_id', { length: 128 }).notNull(),
    agentTitle: varchar('agent_title', { length: 256 }),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    status: agentMiningStatusEnum('status').notNull().default('pending'),
    cliInvocationId: uuid('cli_invocation_id'),
    output: jsonb('output').$type<unknown>(),
    rawOutput: text('raw_output'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_step_agent_minings_task_step_id_idx').on(table.taskStepId),
    uniqueIndex('task_step_agent_minings_step_agent_idx').on(table.taskStepId, table.agentId),
  ],
);

// --- Per-user, per-step CLI provider preferences -----------------------
// Records which CLI a user last picked for each step id. Step-runner uses
// this as the preferred provider when dispatching that step. Set by:
//   - the runner whenever a step's CLI invocation is enqueued (so the
//     last-actually-used wins, not just the dropdown click)
//   - the UI dropdown when the user explicitly picks a CLI for a step
// FK cascade: deleting the user or the cli_provider drops the row.

export const userStepCliPreferences = pgTable(
  'user_step_cli_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stepId: varchar('step_id', { length: 128 }).notNull(),
    cliProviderId: uuid('cli_provider_id')
      .notNull()
      .references(() => cliProviders.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_step_cli_pref_pk').on(table.userId, table.stepId)],
);

// --- CLI Invocations -----------------------------------------------------

export const cliInvocations = pgTable(
  'cli_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'set null',
    }),
    mode: cliInvocationModeEnum('mode').notNull(),
    prompt: text('prompt').notNull(),
    envVars: jsonb('env_vars').$type<Record<string, string>>(),
    exitCode: integer('exit_code'),
    rawOutput: text('raw_output'),
    /** Full live-stream transcript: command header + every stdout/stderr
     *  chunk + the final exit annotation, exactly as the cli-stream WS
     *  delivered them. Used by the inline per-step terminal viewer for
     *  historical replay. Null on rows written before this column was
     *  added; consumers should fall back to rawOutput in that case. */
    streamLog: text('stream_log'),
    /** Set when the step-runner has incorporated this invocation's output
     *  into an apply pass. resolveLlmPhase ignores consumed rows so the
     *  next pass enqueues a fresh invocation. Null = pending or in-flight. */
    consumedAt: timestamp('consumed_at'),
    parsedOutput: jsonb('parsed_output').$type<unknown>(),
    tokenUsage: jsonb('token_usage').$type<{
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>(),
    durationMs: integer('duration_ms'),
    containerId: varchar('container_id', { length: 255 }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    supersededAt: timestamp('superseded_at'),
  },
  (table) => [
    index('cli_invocations_task_id_idx').on(table.taskId),
    index('cli_invocations_task_step_id_idx').on(table.taskStepId),
  ],
);

// --- Sandbox Containers --------------------------------------------------

export const containers = pgTable(
  'containers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    purpose: containerPurposeEnum('purpose').notNull().default('task'),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'cascade',
    }),
    runtime: containerRuntimeEnum('runtime').notNull().default('clawker'),
    dockerContainerId: varchar('docker_container_id', { length: 255 }),
    name: varchar('name', { length: 255 }),
    status: containerStatusEnum('status').notNull().default('creating'),
    mountPaths: jsonb('mount_paths').$type<Record<string, string>>(),
    envVars: jsonb('env_vars').$type<Record<string, string>>(),
    pid: integer('pid'),
    attachedWsCount: integer('attached_ws_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    destroyedAt: timestamp('destroyed_at'),
  },
  (table) => [
    index('containers_task_id_idx').on(table.taskId),
    index('containers_status_idx').on(table.status),
    index('containers_cli_provider_id_idx').on(table.cliProviderId),
  ],
);

// --- Environment Replication --------------------------------------------

export const envTemplates = pgTable(
  'env_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    name: varchar('name', { length: 255 }).notNull(),
    baseImage: varchar('base_image', { length: 255 }).notNull(),
    declaredDeps: jsonb('declared_deps').$type<Record<string, unknown>>(),
    generatedDockerfile: text('generated_dockerfile'),
    dockerfileHash: varchar('dockerfile_hash', { length: 64 }),
    imageTag: varchar('image_tag', { length: 255 }),
    builtImageId: varchar('built_image_id', { length: 255 }),
    status: envTemplateStatusEnum('status').notNull().default('pending'),
    lastBuiltAt: timestamp('last_built_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('env_templates_user_id_idx').on(table.userId),
    index('env_templates_repository_id_idx').on(table.repositoryId),
    uniqueIndex('env_templates_user_hash_idx').on(table.userId, table.dockerfileHash),
  ],
);

export const envTemplateFiles = pgTable(
  'env_template_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    envTemplateId: uuid('env_template_id')
      .notNull()
      .references(() => envTemplates.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    contents: text('contents').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('env_template_files_template_id_idx').on(table.envTemplateId)],
);

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

// --- Terminal Sessions --------------------------------------------------

export const terminalSessions = pgTable(
  'terminal_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    containerId: uuid('container_id')
      .notNull()
      .references(() => containers.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
    fullLog: text('full_log').notNull().default(''),
    byteCount: integer('byte_count').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
  },
  (table) => [
    index('terminal_sessions_user_id_idx').on(table.userId),
    index('terminal_sessions_container_id_idx').on(table.containerId),
  ],
);

// --- Relations ----------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  userSecrets: many(userSecrets),
  cliProviders: many(cliProviders),
  repositories: many(repositories),
  repoCredentials: many(repoCredentials),
  repoUploads: many(repoUploads),
  tasks: many(tasks),
  envTemplates: many(envTemplates),
  terminalSessions: many(terminalSessions),
  customBundles: many(customBundles),
  customBundleUploads: many(customBundleUploads),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export const userSecretsRelations = relations(userSecrets, ({ one }) => ({
  user: one(users, { fields: [userSecrets.userId], references: [users.id] }),
}));

export const cliProvidersRelations = relations(cliProviders, ({ one, many }) => ({
  user: one(users, { fields: [cliProviders.userId], references: [users.id] }),
  secrets: many(cliProviderSecrets),
  tasks: many(tasks),
  invocations: many(cliInvocations),
  loginContainers: many(containers),
}));

export const cliProviderSecretsRelations = relations(cliProviderSecrets, ({ one }) => ({
  provider: one(cliProviders, {
    fields: [cliProviderSecrets.providerId],
    references: [cliProviders.id],
  }),
}));

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

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  user: one(users, { fields: [tasks.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [tasks.repositoryId],
    references: [repositories.id],
  }),
  cliProvider: one(cliProviders, {
    fields: [tasks.cliProviderId],
    references: [cliProviders.id],
  }),
  envTemplate: one(envTemplates, {
    fields: [tasks.envTemplateId],
    references: [envTemplates.id],
  }),
  steps: many(taskSteps),
  events: many(taskEvents),
  invocations: many(cliInvocations),
  containers: many(containers),
}));

export const taskStepsRelations = relations(taskSteps, ({ one, many }) => ({
  task: one(tasks, { fields: [taskSteps.taskId], references: [tasks.id] }),
  events: many(taskEvents),
  userInputs: many(taskUserInputs),
  invocations: many(cliInvocations),
}));

export const taskEventsRelations = relations(taskEvents, ({ one }) => ({
  task: one(tasks, { fields: [taskEvents.taskId], references: [tasks.id] }),
  step: one(taskSteps, { fields: [taskEvents.taskStepId], references: [taskSteps.id] }),
}));

export const taskUserInputsRelations = relations(taskUserInputs, ({ one }) => ({
  step: one(taskSteps, { fields: [taskUserInputs.taskStepId], references: [taskSteps.id] }),
}));

export const cliInvocationsRelations = relations(cliInvocations, ({ one }) => ({
  task: one(tasks, { fields: [cliInvocations.taskId], references: [tasks.id] }),
  step: one(taskSteps, { fields: [cliInvocations.taskStepId], references: [taskSteps.id] }),
  cliProvider: one(cliProviders, {
    fields: [cliInvocations.cliProviderId],
    references: [cliProviders.id],
  }),
}));

export const containersRelations = relations(containers, ({ one, many }) => ({
  task: one(tasks, { fields: [containers.taskId], references: [tasks.id] }),
  cliProvider: one(cliProviders, {
    fields: [containers.cliProviderId],
    references: [cliProviders.id],
  }),
  terminalSessions: many(terminalSessions),
}));

export const terminalSessionsRelations = relations(terminalSessions, ({ one }) => ({
  user: one(users, { fields: [terminalSessions.userId], references: [users.id] }),
  container: one(containers, {
    fields: [terminalSessions.containerId],
    references: [containers.id],
  }),
}));

export const envTemplatesRelations = relations(envTemplates, ({ one, many }) => ({
  user: one(users, { fields: [envTemplates.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [envTemplates.repositoryId],
    references: [repositories.id],
  }),
  files: many(envTemplateFiles),
  tasks: many(tasks),
}));

export const envTemplateFilesRelations = relations(envTemplateFiles, ({ one }) => ({
  template: one(envTemplates, {
    fields: [envTemplateFiles.envTemplateId],
    references: [envTemplates.id],
  }),
}));

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
