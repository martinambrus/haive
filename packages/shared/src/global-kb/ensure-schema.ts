import { logger } from '../logger/index.js';
import type { GlobalKbConnection } from './connection.js';

const log = logger.child({ module: 'global-kb-schema' });

const ENTRIES_TABLE = 'global_kb_entries';
const VECTORS_TABLE = 'ai_rag_embeddings';

// Facet dimensions that get a dedicated expression GIN index (the hot ones used
// by the query-time facet filter, §3.4). `facets` JSONB lives on the vectors
// table; a broad GIN(facets) (default jsonb_ops, NOT jsonb_path_ops) backs the
// `?` / `?|` operators, and these per-array indexes speed the common dimensions.
const FACET_DIMENSIONS = ['framework', 'language', 'phpMajor', 'nodeMajor', 'packages', 'tags'];

/** Idempotent schema creation for the global KB store (both the source-of-truth
 *  `global_kb_entries` and the global `ai_rag_embeddings` vector table), run on
 *  the global connection at first use. Mirrors the per-project `ensureRagSchema`
 *  (pgvector with jsonb fallback) but adds namespace/user_id/entry_id/facets and
 *  the JSONB facet indexes. Never touches the main DB or the per-project schema. */
export async function ensureGlobalKbSchema(
  conn: GlobalKbConnection,
): Promise<{ usedPgvector: boolean }> {
  let usedPgvector = true;
  try {
    await conn.pg`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch (err) {
    log.warn({ err }, 'pgvector unavailable; global KB falls back to jsonb embeddings');
    usedPgvector = false;
  }

  const dims = conn.embeddingDimensions;

  // 1. Source-of-truth entries table. Enum-like fields use TEXT CHECK rather than
  //    PG enum types so there are no main-DB enum migrations to coordinate.
  await conn.pg.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      namespace TEXT NOT NULL,
      user_id uuid,
      title TEXT NOT NULL,
      seed_text TEXT,
      body TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('general','tech_pattern','anti_pattern','best_practice','quick_reference')),
      facets jsonb NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL CHECK (status IN ('skeleton','enriching','draft','active','archived')),
      source TEXT NOT NULL CHECK (source IN ('user','promoted')),
      source_task_id uuid,
      source_repo_id uuid,
      content_hash TEXT,
      embed_status TEXT NOT NULL DEFAULT 'pending' CHECK (embed_status IN ('pending','embedded','failed','stale')),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      superseded_at TIMESTAMP
    )
  `);
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_global_kb_entries_ns_status ON ${ENTRIES_TABLE} (namespace, status)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_global_kb_entries_embed_status ON ${ENTRIES_TABLE} (embed_status)`,
  );

  // 2. Global vector table — the per-project ai_rag_embeddings shape PLUS
  //    namespace/user_id/entry_id/facets. pgvector primary, jsonb fallback.
  if (usedPgvector) {
    await conn.pg.unsafe(`
      CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
        id SERIAL PRIMARY KEY,
        namespace TEXT NOT NULL,
        user_id uuid,
        entry_id uuid NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'kb',
        source_path TEXT NOT NULL,
        section_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_hash TEXT,
        facets jsonb NOT NULL DEFAULT '{}'::jsonb,
        content TEXT NOT NULL,
        vector vector(${dims}) NOT NULL,
        content_tsv tsvector,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    try {
      await conn.pg.unsafe(
        `CREATE INDEX IF NOT EXISTS idx_global_rag_vector_hnsw ON ${VECTORS_TABLE} USING hnsw ((vector::halfvec(${dims})) halfvec_cosine_ops)`,
      );
    } catch (err) {
      log.warn({ err }, 'global KB HNSW index creation failed; vector search uses sequential scan');
    }
  } else {
    await conn.pg.unsafe(`
      CREATE TABLE IF NOT EXISTS ${VECTORS_TABLE} (
        id SERIAL PRIMARY KEY,
        namespace TEXT NOT NULL,
        user_id uuid,
        entry_id uuid NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'kb',
        source_path TEXT NOT NULL,
        section_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_hash TEXT,
        facets jsonb NOT NULL DEFAULT '{}'::jsonb,
        content TEXT NOT NULL,
        embedding_json jsonb NOT NULL,
        content_tsv tsvector,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }

  // Upsert key + lookup/scope indexes (both variants).
  await conn.pg.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_global_rag_ns_entry_section_chunk ON ${VECTORS_TABLE} (namespace, entry_id, section_id, chunk_index)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_global_rag_namespace ON ${VECTORS_TABLE} (namespace)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_global_rag_entry_id ON ${VECTORS_TABLE} (entry_id)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_global_rag_content_tsv ON ${VECTORS_TABLE} USING GIN (content_tsv)`,
  );

  // Facet indexes: broad default-jsonb_ops GIN (supports ? / ?|) + per-array.
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_global_rag_facets ON ${VECTORS_TABLE} USING GIN (facets)`,
  );
  for (const dim of FACET_DIMENSIONS) {
    await conn.pg.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_global_rag_facets_${dim.toLowerCase()} ON ${VECTORS_TABLE} USING GIN ((facets->'${dim}'))`,
    );
  }

  // tsvector auto-update trigger (mirror ensureRagSchema; distinct trigger name
  // since this is a different database).
  await conn.pg.unsafe(`
    CREATE OR REPLACE FUNCTION update_content_tsv() RETURNS trigger AS $$
    BEGIN
      NEW.content_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  const triggerExists = await conn.pg.unsafe(
    `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_global_content_tsv'`,
  );
  if (triggerExists.length === 0) {
    await conn.pg.unsafe(`
      CREATE TRIGGER trg_global_content_tsv
        BEFORE INSERT OR UPDATE ON ${VECTORS_TABLE}
        FOR EACH ROW EXECUTE FUNCTION update_content_tsv()
    `);
  }

  return { usedPgvector };
}
