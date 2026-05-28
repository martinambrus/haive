import {
  pgTable,
  uuid,
  varchar,
  integer,
  jsonb,
  timestamp,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tasks } from './tasks.js';
import { cliProviders } from './cli-providers.js';
import { terminalSessions } from './terminal.js';

export const containerRuntimeEnum = pgEnum('container_runtime', ['clawker', 'dockerode']);
export const containerStatusEnum = pgEnum('container_status', [
  'creating',
  'running',
  'stopped',
  'destroyed',
  'error',
]);
export const containerPurposeEnum = pgEnum('container_purpose', ['task', 'cli_login']);

// --- Sandbox Containers --------------------------------------------------

export const containers = pgTable(
  'containers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    purpose: containerPurposeEnum('purpose').notNull().default('task'),
    cliProviderId: uuid('cli_provider_id').references(() => cliProviders.id, {
      onDelete: 'cascade',
    }),
    runtime: containerRuntimeEnum('runtime').notNull().default('clawker'),
    dockerContainerId: varchar('docker_container_id', { length: 255 }),
    name: varchar('name', { length: 255 }),
    status: containerStatusEnum('status').notNull().default('creating'),
    mountPaths: jsonb('mount_paths').$type<Record<string, string>>(),
    envVars: jsonb('env_vars').$type<Record<string, string>>(),
    pid: integer('pid'),
    attachedWsCount: integer('attached_ws_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    destroyedAt: timestamp('destroyed_at'),
  },
  (table) => [
    index('containers_task_id_idx').on(table.taskId),
    index('containers_status_idx').on(table.status),
    index('containers_cli_provider_id_idx').on(table.cliProviderId),
  ],
);

export const containersRelations = relations(containers, ({ one, many }) => ({
  task: one(tasks, { fields: [containers.taskId], references: [tasks.id] }),
  cliProvider: one(cliProviders, {
    fields: [containers.cliProviderId],
    references: [cliProviders.id],
  }),
  terminalSessions: many(terminalSessions),
}));
