import { index, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

// No owner FK: deleting a provider must not admit another writer to its shared volume.
export const cliAuthContainers = pgTable(
  'cli_auth_containers',
  {
    dockerContainerId: varchar('docker_container_id', { length: 255 }).primaryKey(),
    scope: varchar('scope', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('cli_auth_containers_scope_idx').on(table.scope)],
);
