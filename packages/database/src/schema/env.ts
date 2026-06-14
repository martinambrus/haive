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
import { relations, sql } from 'drizzle-orm';
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
// status). Upsert target is (repository_id, step_id, name); cascade on repo delete.

export const envDepPresets = pgTable(
  'env_dep_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Null = a global preset, reusable across all of the user's repos. A set
    // value scopes the preset to that repository (cascade-deletes with it).
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 255 }).notNull(),
    // Which env-replicate step's form this preset snapshots: '01-declare-deps'
    // (the dependency form) or '02-generate-dockerfile' (the Dockerfile). One
    // preset store serves every step, scoped per (repo, step, name).
    stepId: text('step_id').notNull().default('01-declare-deps'),
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('env_dep_presets_repository_id_idx').on(table.repositoryId),
    // Repo-scoped presets are unique per (repo, step, name). NULL repository_id
    // (globals) are distinct under this index, so a separate partial unique keys
    // globals per (user, step, name).
    uniqueIndex('env_dep_presets_repo_step_name_idx').on(
      table.repositoryId,
      table.stepId,
      table.name,
    ),
    uniqueIndex('env_dep_presets_global_step_name_idx')
      .on(table.userId, table.stepId, table.name)
      .where(sql`${table.repositoryId} IS NULL`),
  ],
);

export const envDepPresetsRelations = relations(envDepPresets, ({ one }) => ({
  user: one(users, { fields: [envDepPresets.userId], references: [users.id] }),
  repository: one(repositories, {
    fields: [envDepPresets.repositoryId],
    references: [repositories.id],
  }),
}));
