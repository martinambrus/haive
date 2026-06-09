import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { tasks } from './tasks.js';

// One row per rag_search call made through /rag/search. Captures retrieval
// efficiency (how many hits) and the KB-vs-code split + top scores, so the UI
// can show whether code (not just KB) is actually being retrieved. Lives in the
// main haive DB — app telemetry, NOT in the per-project vector DB. Attributed to
// a step by created_at time window (queries during a step's run window).
export const ragQueryLog = pgTable(
  'rag_query_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    topK: integer('top_k'),
    hitCount: integer('hit_count').notNull().default(0),
    kbHits: integer('kb_hits').notNull().default(0),
    codeHits: integer('code_hits').notNull().default(0),
    maxRrf: doublePrecision('max_rrf').notNull().default(0),
    maxDense: doublePrecision('max_dense').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('rag_query_log_task_created_idx').on(table.taskId, table.createdAt)],
);

export const ragQueryLogRelations = relations(ragQueryLog, ({ one }) => ({
  task: one(tasks, { fields: [ragQueryLog.taskId], references: [tasks.id] }),
}));
