import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

export const moduleSources = pgTable(
  'module_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: ['git', 'registry'] }).notNull(),
    moduleId: text('module_id').notNull().unique(),
    url: text('url'),
    ref: text('ref'),
    packageName: text('package_name'),
    version: text('version'),
    hasToken: boolean('has_token').notNull().default(false),
    resolvedSha: text('resolved_sha'),
    fetchStatus: text('fetch_status'),
    fetchedAt: timestamp('fetched_at'),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  () => [
    check('module_sources_kind_check', sql.raw("kind IN ('git', 'registry')")),
    check('module_sources_module_id_check', sql.raw("module_id ~ '^[a-z0-9][a-z0-9-]{0,22}$'")),
    check(
      'module_sources_fields_check',
      sql.raw(
        "(kind = 'git' AND url IS NOT NULL AND ref IS NOT NULL AND length(ref) > 0 AND package_name IS NULL AND version IS NULL) OR " +
          "(kind = 'registry' AND url IS NULL AND ref IS NULL AND package_name IS NOT NULL AND package_name = '@haive-module/' || module_id AND version IS NOT NULL AND length(version) > 0)",
      ),
    ),
  ],
);
