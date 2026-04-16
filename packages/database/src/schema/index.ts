import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// --- Enums --------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', ['admin', 'user']);
export const userStatusEnum = pgEnum('user_status', ['active', 'deactivated']);

export const cliProviderNameEnum = pgEnum('cli_provider_name', [
  'claude-code',
  'codex',
  'gemini',
  'amp',
  'grok',
  'qwen',
  'kiro',
  'zai',
]);
export const cliAuthModeEnum = pgEnum('cli_auth_mode', ['subscription', 'api_key', 'mixed']);
export const cliSandboxBuildStatusEnum = pgEnum('cli_sandbox_build_status', [
  'idle',
  'building',
  'ready',
  'failed',
]);
export const cliInvocationModeEnum = pgEnum('cli_invocation_mode', [
  'api',
  'cli',
  'subagent_emulated',
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

export const workflowTypeEnum = pgEnum('workflow_type', [
  'onboarding',
  'workflow',
  'env_replicate',
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

export const containerRuntimeEnum = pgEnum('container_runtime', ['clawker', 'dockerode']);
export const containerStatusEnum = pgEnum('container_status', [
  'creating',
  'running',
  'stopped',
  'destroyed',
  'error',
]);

export const envTemplateStatusEnum = pgEnum('env_template_status', [
  'pending',
  'building',
  'ready',
  'failed',
]);

// --- Auth ---------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailEncrypted: text('email_encrypted').notNull(),
    emailBlindIndex: varchar('email_blind_index', { length: 64 }).notNull(),
    passwordHash: text('password_hash').notNull(),
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
    sandboxDockerfileExtra: text('sandbox_dockerfile_extra'),
    sandboxImageTag: text('sandbox_image_tag'),
    sandboxImageBuildStatus: cliSandboxBuildStatusEnum('sandbox_image_build_status')
      .notNull()
      .default('idle'),
    sandboxImageBuildError: text('sandbox_image_build_error'),
    sandboxImageBuiltAt: timestamp('sandbox_image_built_at'),
    enabled: boolean('enabled').notNull().default(true),
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('repositories_user_id_idx').on(table.userId),
    index('repositories_status_idx').on(table.status),
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
    currentStepIndex: integer('current_step_index').notNull().default(0),
    containerId: varchar('container_id', { length: 255 }),
    worktreePath: text('worktree_path'),
    memoryLimitMb: integer('memory_limit_mb'),
    cpuLimitMilli: integer('cpu_limit_milli'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
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
    stepIndex: integer('step_index').notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    detectOutput: jsonb('detect_output').$type<unknown>(),
    formSchema: jsonb('form_schema').$type<unknown>(),
    formValues: jsonb('form_values').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<unknown>(),
    errorMessage: text('error_message'),
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
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
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
  tasks: many(tasks),
  envTemplates: many(envTemplates),
  terminalSessions: many(terminalSessions),
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
}));

export const repoCredentialsRelations = relations(repoCredentials, ({ one, many }) => ({
  user: one(users, { fields: [repoCredentials.userId], references: [users.id] }),
  repositories: many(repositories),
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
