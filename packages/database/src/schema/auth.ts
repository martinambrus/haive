import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { cliProviders } from './cli-providers.js';
import { repositories, repoCredentials, repoUploads } from './repos.js';
import { tasks } from './tasks.js';
import { envTemplates } from './env.js';
import { terminalSessions } from './terminal.js';
import { customBundles, customBundleUploads } from './bundles.js';

export const userRoleEnum = pgEnum('user_role', ['admin', 'user']);
export const userStatusEnum = pgEnum('user_status', ['active', 'deactivated']);

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
    // Set wherever a password this account's holder did not choose is minted for them, cleared by
    // PUT /user-settings/password. See migration 0154.
    mustChangePassword: boolean('must_change_password').notNull().default(false),
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

/**
 * An invitation to create an account while registration is not open.
 *
 * The token is stored HASHED, exactly as `refresh_tokens.token_hash` is: the raw value is shown to
 * the admin once and never persisted, so a database dump does not hand out working invite links.
 *
 * `emailBlindIndex` is nullable on purpose — an invite is either bound to one address (the common
 * "invite this person" case) or a generic link the admin passes on. It is a BLIND INDEX rather than
 * an address because that is the only form this schema can match against: `users.email_encrypted`
 * is encrypted and cannot be compared.
 *
 * `consumedAt` rather than a delete: an invite that has been used is evidence of how someone got
 * in, and the audit trail is worth more than the row is worth reclaiming. `revokedAt` is separate
 * because "the admin cancelled it" and "somebody used it" are different facts about a token.
 */
export const userInvites = pgTable(
  'user_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailBlindIndex: varchar('email_blind_index', { length: 64 }),
    tokenHash: text('token_hash').notNull().unique(),
    role: userRoleEnum('role').notNull().default('user'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    consumedAt: timestamp('consumed_at'),
    consumedByUserId: uuid('consumed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // The redeem path looks a token up by hash; everything else is an admin listing.
    index('user_invites_email_blind_index_idx').on(table.emailBlindIndex),
    index('user_invites_created_at_idx').on(table.createdAt),
  ],
);
export const userInvitesRelations = relations(userInvites, ({ one }) => ({
  creator: one(users, { fields: [userInvites.createdBy], references: [users.id] }),
  consumer: one(users, { fields: [userInvites.consumedByUserId], references: [users.id] }),
}));

export const userSecretsRelations = relations(userSecrets, ({ one }) => ({
  user: one(users, { fields: [userSecrets.userId], references: [users.id] }),
}));
