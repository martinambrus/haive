import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, uuid, text, varchar, bigint, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';
import { tasks } from './tasks.js';

/** User-supplied reference files attached to a task (documentation, screenshots,
 *  sample data). Stored on the haive_repos volume under
 *  `<repoRoot>/.haive/task-uploads/<taskId>/` so the AI CLI agent can read them
 *  at `/haive/workdir/.haive/task-uploads/<taskId>/`. Unlike db_uploads these are
 *  not consumed/deleted by a step — they persist for the life of the task.
 *
 *  `filename` is a RELATIVE PATH, not a basename: a folder upload keeps its
 *  structure (`docs/api/spec.md`), and expanding an uploaded archive produces the
 *  same rows a folder upload would have. */
export const taskAttachments = pgTable(
  'task_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    storedPath: text('stored_path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentType: varchar('content_type', { length: 128 }),
    description: text('description'),
    /** The archive this file came out of, for rows the worker's expansion wrote.
     *  NULL for anything the user uploaded directly. Cascades so removing the
     *  archive removes what it produced. Also what stops expansion recursing: a
     *  row with a parent is never itself a candidate. */
    expandedFromId: uuid('expanded_from_id').references((): AnyPgColumn => taskAttachments.id, {
      onDelete: 'cascade',
    }),
    /** When this archive was expanded — the idempotency guard. Stamped even when
     *  the expansion produced nothing, or it would be retried on every step. */
    expandedAt: timestamp('expanded_at'),
    /** Why an expansion produced nothing or less than the archive holds (a cap
     *  breach, an unreadable archive). Display copy; nothing branches on it. */
    expansionNote: text('expansion_note'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_attachments_task_id_idx').on(table.taskId),
    index('task_attachments_user_id_idx').on(table.userId),
    index('task_attachments_expanded_from_idx').on(table.expandedFromId),
  ],
);

export const taskAttachmentsRelations = relations(taskAttachments, ({ one }) => ({
  task: one(tasks, { fields: [taskAttachments.taskId], references: [tasks.id] }),
  user: one(users, { fields: [taskAttachments.userId], references: [users.id] }),
}));
