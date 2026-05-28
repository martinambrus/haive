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
