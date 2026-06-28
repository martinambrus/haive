import { pgTable, uuid, text, varchar, bigint, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';
import { tasks } from './tasks.js';

/** User-supplied reference files attached to a task (documentation, screenshots,
 *  sample data). Stored on the haive_repos volume under
 *  `<repoRoot>/.haive/task-uploads/<taskId>/` so the AI CLI agent can read them
 *  at `/haive/workdir/.haive/task-uploads/<taskId>/`. Unlike db_uploads these are
 *  not consumed/deleted by a step — they persist for the life of the task. */
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
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('task_attachments_task_id_idx').on(table.taskId),
    index('task_attachments_user_id_idx').on(table.userId),
  ],
);

export const taskAttachmentsRelations = relations(taskAttachments, ({ one }) => ({
  task: one(tasks, { fields: [taskAttachments.taskId], references: [tasks.id] }),
  user: one(users, { fields: [taskAttachments.userId], references: [users.id] }),
}));
