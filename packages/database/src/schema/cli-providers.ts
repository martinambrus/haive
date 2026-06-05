import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';
import { tasks, cliInvocations } from './tasks.js';
import { containers } from './containers.js';

export const cliProviderNameEnum = pgEnum('cli_provider_name', [
  'claude-code',
  'codex',
  'gemini',
  'amp',
  'zai',
  'antigravity',
]);
export const cliAuthModeEnum = pgEnum('cli_auth_mode', ['subscription', 'api_key']);
export const cliSandboxBuildStatusEnum = pgEnum('cli_sandbox_build_status', [
  'idle',
  'building',
  'ready',
  'failed',
]);

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
    /** True only for overrides the user set explicitly via the task UI.
     *  Legacy auto-recorded rows default to false and are ignored by the
     *  runner and UI so the task-level provider choice is honored. */
    explicit: boolean('explicit').notNull().default(false),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('user_step_cli_pref_pk').on(table.userId, table.stepId)],
);

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
