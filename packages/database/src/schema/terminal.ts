import { pgTable, uuid, text, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';
import { containers } from './containers.js';

// --- Terminal Sessions --------------------------------------------------

export const terminalSessions = pgTable(
  'terminal_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    containerId: uuid('container_id')
      .notNull()
      .references(() => containers.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
    fullLog: text('full_log').notNull().default(''),
    byteCount: integer('byte_count').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
  },
  (table) => [
    index('terminal_sessions_user_id_idx').on(table.userId),
    index('terminal_sessions_container_id_idx').on(table.containerId),
  ],
);

export const terminalSessionsRelations = relations(terminalSessions, ({ one }) => ({
  user: one(users, { fields: [terminalSessions.userId], references: [users.id] }),
  container: one(containers, {
    fields: [terminalSessions.containerId],
    references: [containers.id],
  }),
}));
