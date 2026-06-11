import { pgTable, uuid, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';

// Global cross-task KB schema. Lives in a SEPARATE database (internal
// haive_kb_global or an external/central Postgres), NOT the main Haive DB, so it
// is intentionally NOT exported from @haive/database/schema — drizzle-kit must
// never try to migrate it onto DATABASE_URL. Tables are created by raw idempotent
// SQL (ensureGlobalKbSchema); this Drizzle object exists only for typed CRUD over
// global_kb_entries. The global vector table (ai_rag_embeddings) is written via
// raw SQL by the sync job, mirroring the per-project store, so it needs no Drizzle
// definition here. See plan luminous-weaving-archive.md §4.1/§4.2.

/** Version/variant scope facets. Each dimension is a SET of allowed values; an
 *  empty/absent dimension means "applies to all" for that dimension (§3.1). */
export interface GlobalKbFacets {
  framework?: string[];
  /** Major version of the framework, e.g. ["11"] for Drupal 11 — distinguishes
   *  same-family majors that `framework` alone cannot (Drupal 11 vs 12). */
  frameworkMajor?: string[];
  language?: string[];
  phpMajor?: string[];
  nodeMajor?: string[];
  packages?: string[];
  tags?: string[];
}

export type GlobalKbCategory =
  | 'general'
  | 'tech_pattern'
  | 'anti_pattern'
  | 'best_practice'
  | 'quick_reference';

export type GlobalKbStatus = 'skeleton' | 'enriching' | 'draft' | 'active' | 'archived';

export type GlobalKbSource = 'user' | 'promoted';

export type GlobalKbEmbedStatus = 'pending' | 'embedded' | 'failed' | 'stale';

/** Routing decision at the orchestration gate (§5.4). Not a column on entries —
 *  a `global`/`both` choice produces a global_kb_entries row; `local` does not. */
export type GlobalKbScope = 'local' | 'global' | 'both';

export const globalKbEntries = pgTable('global_kb_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Corpus scope key (instance config), NOT a cross-DB user FK. Default 'default'
  // is a single shared corpus; one central server may host several namespaces.
  namespace: text('namespace').notNull(),
  // Opaque provenance only (no FK — different database). Null for some promotions.
  userId: uuid('user_id'),
  title: text('title').notNull(),
  // Raw skeleton the user pasted; null for fully-manual or promoted entries.
  seedText: text('seed_text'),
  // Markdown source of truth (enriched or hand-written).
  body: text('body').notNull(),
  category: text('category').$type<GlobalKbCategory>().notNull(),
  facets: jsonb('facets').$type<GlobalKbFacets>().notNull().default({}),
  status: text('status').$type<GlobalKbStatus>().notNull(),
  source: text('source').$type<GlobalKbSource>().notNull(),
  // Provenance for promotions; plain uuids, no FK (different database).
  sourceTaskId: uuid('source_task_id'),
  sourceRepoId: uuid('source_repo_id'),
  // sha256 of body+facets; drives re-embed when content changes.
  contentHash: text('content_hash'),
  embedStatus: text('embed_status').$type<GlobalKbEmbedStatus>().notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // Soft-delete, matches repo conventions.
  supersededAt: timestamp('superseded_at'),
});

export type GlobalKbEntry = typeof globalKbEntries.$inferSelect;
export type NewGlobalKbEntry = typeof globalKbEntries.$inferInsert;

export const globalKbSchema = { globalKbEntries };

/** Wrap a postgres.js client bound to the global DB connection in a typed Drizzle
 *  client. Schema creation happens out-of-band via ensureGlobalKbSchema. */
export function createGlobalKbDb(pg: postgres.Sql) {
  return drizzle(pg, { schema: globalKbSchema });
}

export type GlobalKbDb = ReturnType<typeof createGlobalKbDb>;
