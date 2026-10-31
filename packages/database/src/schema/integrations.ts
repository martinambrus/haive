import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  uniqueIndex,
  primaryKey,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './auth.js';
import { repositories, repoCredentials } from './repos.js';
import { tasks, taskSteps, cliInvocations } from './tasks.js';

export const integrationConnectionScopeEnum = pgEnum('integration_connection_scope', [
  'user',
  'shared',
]);
export const integrationConnectionStatusEnum = pgEnum('integration_connection_status', [
  'connected',
  'needs_reauth',
  'revoked',
  'provider_unavailable',
]);
export const integrationGrantTargetEnum = pgEnum('integration_grant_target', [
  'task',
  'repository',
]);
export const integrationAccessEnum = pgEnum('integration_access', ['read', 'write']);
export const integrationSurfaceEnum = pgEnum('integration_surface', ['mcp', 'rest']);
export const integrationCallOutcomeEnum = pgEnum('integration_call_outcome', [
  'ok',
  'refused',
  'error',
  'running',
]);

export const integrationProviderConfigs = pgTable('integration_provider_configs', {
  providerId: varchar('provider_id', { length: 256 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  oauthClientId: text('oauth_client_id'),
  oauthClientSecretEncrypted: text('oauth_client_secret_encrypted'),
  encryptedDek: text('encrypted_dek'),
  apiBaseUrl: text('api_base_url'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: varchar('provider_id', { length: 256 }).notNull(),
    scope: integrationConnectionScopeEnum('scope').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountLabel: text('account_label').notNull(),
    externalAccountId: text('external_account_id'),
    authMethod: varchar('auth_method', { length: 16 }).notNull(),
    grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull().default([]),
    accessTokenEncrypted: text('access_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    encryptedDek: text('encrypted_dek'),
    expiresAt: timestamp('expires_at'),
    repoCredentialId: uuid('repo_credential_id').references(() => repoCredentials.id, {
      onDelete: 'cascade',
    }),
    writeEnabled: boolean('write_enabled').notNull().default(false),
    status: integrationConnectionStatusEnum('status').notNull().default('connected'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    oauthClientId: text('oauth_client_id'),
    /** When the provider's OAuth client last refused a refresh. The status stays `connected`, so this
     *  is what says `last_error` is current; the next refresh that succeeds and a sign-in clear it. */
    refreshRefusedAt: timestamp('refresh_refused_at'),
  },
  (table) => [
    index('integration_connections_owner_user_id_idx').on(table.ownerUserId),
    index('integration_connections_provider_id_idx').on(table.providerId),
    uniqueIndex('integration_connections_account_key_idx')
      .on(table.scope, table.ownerUserId, table.providerId, table.externalAccountId)
      .where(sql`${table.externalAccountId} IS NOT NULL`),
    uniqueIndex('integration_connections_repo_credential_key_idx')
      .on(table.repoCredentialId)
      .where(sql`${table.repoCredentialId} IS NOT NULL`),
  ],
);

export const integrationGrants = pgTable(
  'integration_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    targetKind: integrationGrantTargetEnum('target_kind').notNull(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'cascade',
    }),
    categoryId: varchar('category_id', { length: 256 }),
    toolAllowList: jsonb('tool_allow_list').$type<string[] | null>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'integration_grants_target_check',
      sql`(${table.targetKind} = 'task' AND ${table.taskId} IS NOT NULL AND ${table.repositoryId} IS NULL) OR (${table.targetKind} = 'repository' AND ${table.repositoryId} IS NOT NULL AND ${table.taskId} IS NULL)`,
    ),
    index('integration_grants_task_id_idx').on(table.taskId),
    index('integration_grants_repository_id_idx').on(table.repositoryId),
    index('integration_grants_connection_id_idx').on(table.connectionId),
    uniqueIndex('integration_grants_task_category_key_idx')
      .on(table.taskId, table.categoryId)
      .where(sql`${table.targetKind} = 'task'`),
    uniqueIndex('integration_grants_repository_connection_key_idx')
      .on(table.repositoryId, table.connectionId)
      .where(sql`${table.targetKind} = 'repository'`),
  ],
);

export const integrationUserSettings = pgTable(
  'integration_user_settings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: varchar('provider_id', { length: 256 }).notNull(),
    writeEnabled: boolean('write_enabled').notNull().default(false),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.providerId] })],
);

export const integrationCategoryPreferences = pgTable(
  'integration_category_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    categoryId: varchar('category_id', { length: 256 }).notNull(),
    providerId: varchar('provider_id', { length: 256 }).notNull(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    connectionId: uuid('connection_id').references(() => integrationConnections.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    unique('integration_category_preferences_user_category_unique')
      .on(table.userId, table.categoryId)
      .nullsNotDistinct(),
  ],
);

export const taskIntegrationChoices = pgTable(
  'task_integration_choices',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    categoryId: varchar('category_id', { length: 256 }).notNull(),
    providerId: varchar('provider_id', { length: 256 }).notNull(),
    connectionId: uuid('connection_id').references(() => integrationConnections.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.categoryId] })],
);

export const integrationCalls = pgTable(
  'integration_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id').references(() => integrationConnections.id, {
      onDelete: 'set null',
    }),
    providerId: varchar('provider_id', { length: 256 }).notNull(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    taskStepId: uuid('task_step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    cliInvocationId: uuid('cli_invocation_id').references(() => cliInvocations.id, {
      onDelete: 'set null',
    }),
    tool: text('tool').notNull(),
    access: integrationAccessEnum('access').notNull(),
    surface: integrationSurfaceEnum('surface').notNull(),
    outcome: integrationCallOutcomeEnum('outcome').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    reason: varchar('reason', { length: 64 }),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    index('integration_calls_task_id_idx').on(table.taskId),
    index('integration_calls_cli_invocation_id_idx').on(table.cliInvocationId),
  ],
);
