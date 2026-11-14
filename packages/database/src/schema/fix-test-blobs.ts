import {
  customType,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tasks } from './tasks.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Content only for changed repair evidence; task events contain manifests/references. */
export const fixTestBlobs = pgTable(
  'fix_test_blobs',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: bytea('content'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    expiredAt: timestamp('expired_at'),
    manifestGzip: bytea('manifest_gzip'),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.contentHash] }),
    index('fix_test_blobs_expiry_idx')
      .on(t.createdAt)
      .where(sql`${t.expiredAt} is null and ${t.content} is not null`),
  ],
);
