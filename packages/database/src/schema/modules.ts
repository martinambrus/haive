import { pgTable, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Four writers, three of them on different columns: the worker boot writes what it loaded last and since when a module that loaded before is missing; the admin toggle writes `deactivatedAt`, null while the module is active, clears `tornDownAt` and moves `updatedAt`, which a running worker reads as the activation stamp; the worker's teardown job stamps `tornDownAt` once a deactivated module's own teardown has run; the api's purge deletes the row of a missing module. */
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
    tornDownAt: timestamp('torn_down_at'),
  },
  (table) => [check('modules_source_check', sql`${table.source} IN ('local', 'git', 'registry')`)],
);
