import { pgTable, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Two writers on different columns: the worker boot writes what it loaded last and since when a module that loaded before is missing; the admin toggle writes `deactivatedAt`, null while the module is active. */
export const modules = pgTable(
  'modules',
  {
    moduleId: text('module_id').primaryKey(),
    packageName: text('package_name').notNull(),
    name: text('name').notNull(),
    source: text('source').notNull().default('local'),
    installedVersion: text('installed_version').notNull(),
    entitlementId: text('entitlement_id'),
    firstLoadedAt: timestamp('first_loaded_at').notNull().defaultNow(),
    lastLoadedAt: timestamp('last_loaded_at').notNull().defaultNow(),
    missingAt: timestamp('missing_at'),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deactivatedAt: timestamp('deactivated_at'),
  },
  (table) => [check('modules_source_check', sql`${table.source} IN ('local', 'git', 'registry')`)],
);
