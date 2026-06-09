import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  bigint,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth.js';

/** Chunked-upload session for a database dump. Mirrors repo_uploads, but the
 *  finished dump is imported into a task's ephemeral DB (then deleted) instead
 *  of extracted into a repository. status: uploading | complete | cancelled |
 *  consumed (set once the import step has loaded it and removed the file). */
export const dbUploads = pgTable(
  'db_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    dumpFormat: varchar('dump_format', { length: 16 }).notNull(),
    totalSize: bigint('total_size', { mode: 'number' }).notNull(),
    bytesReceived: bigint('bytes_received', { mode: 'number' }).notNull().default(0),
    chunkSize: integer('chunk_size').notNull(),
    dumpPath: text('dump_path').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('uploading'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('db_uploads_user_id_idx').on(table.userId),
    index('db_uploads_status_idx').on(table.status),
  ],
);

export const dbUploadsRelations = relations(dbUploads, ({ one }) => ({
  user: one(users, { fields: [dbUploads.userId], references: [users.id] }),
}));
