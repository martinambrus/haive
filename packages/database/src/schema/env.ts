import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';
import { repositories } from './repos.js';
import { tasks } from './tasks.js';

export const envTemplateStatusEnum = pgEnum('env_template_status', [
  'pending',
  'building',
  'ready',
  'failed',
]);

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

// --- Reusable dependency presets (env-replicate step 1) ------------------
// A named snapshot of the `01-declare-deps` form inputs, scoped per repository,
// so the user can prefill the dependency form on future runs instead of
// re-entering all 12 fields by hand. Distinct from `env_templates` above,
// which is the per-task environment state (declared deps + dockerfile + build
// status). Upsert target is (repository_id, name); cascade on repo delete.

export const envDepPresets = pgTable(
  'env_dep_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('env_dep_presets_repository_id_idx').on(table.repositoryId),
    uniqueIndex('env_dep_presets_repo_name_idx').on(table.repositoryId, table.name),
  ],
);

export const envDepPresetsRelations = relations(envDepPresets, ({ one }) => ({
  user: one(users, { fields: [envDepPresets.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [envDepPresets.repositoryId],
    references: [repositories.id],
  }),
}));
