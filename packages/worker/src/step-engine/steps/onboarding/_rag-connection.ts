import { sql } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  IDENTIFIER_TSV_SENTINEL,
  RAG_TABLE,
  identifierTsvSql,
  ragDatabaseName,
  type RagConnection,
} from '@haive/shared/rag';

// Connection resolution + types moved to @haive/shared/rag so the API query
// path can reuse them without importing the worker. Re-exported here so
// existing worker imports keep resolving unchanged. The schema-creation,
// dedup, and cleanup helpers below are populate/cleanup-side and stay worker-local.
export { RAG_TABLE, ragDatabaseName, resolveRagConnection } from '@haive/shared/rag';
export type { RagMode, RagToolingPrefs, RagConnection } from '@haive/shared/rag';

const log = logger.child({ module: 'rag-connection' });

/* ------------------------------------------------------------------ */
/* Schema creation                                                     */
/* ------------------------------------------------------------------ */

export async function ensureRagSchema(
  conn: RagConnection,
): Promise<{ usedPgvector: boolean; tableName: string }> {
  let usedPgvector = true;
  try {
    await conn.pg`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch (err) {
    log.warn({ err }, 'pgvector extension unavailable; falling back to jsonb embeddings');
    usedPgvector = false;
  }

  const dims = conn.embeddingDimensions;

  if (usedPgvector) {
    await conn.pg.unsafe(`
      CREATE TABLE IF NOT EXISTS ${RAG_TABLE} (
        id SERIAL PRIMARY KEY,
        task_id uuid,
        repository_id uuid,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        section_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_hash TEXT,
        content TEXT NOT NULL,
        vector vector(${dims}) NOT NULL,
        content_tsv tsvector,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // HNSW index with halfvec cast (supports >2000 dims). The only index that is
    // specific to this variant — everything else is created for both, below.
    try {
      await conn.pg.unsafe(
        `CREATE INDEX IF NOT EXISTS idx_rag_vector_hnsw ON ${RAG_TABLE} USING hnsw ((vector::halfvec(${dims})) halfvec_cosine_ops)`,
      );
    } catch (err) {
      log.warn({ err }, 'HNSW index creation failed; vector search will use sequential scan');
    }
  } else {
    await conn.pg`
      CREATE TABLE IF NOT EXISTS ${conn.pg(RAG_TABLE)} (
        id SERIAL PRIMARY KEY,
        task_id uuid,
        repository_id uuid,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL,
        section_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_hash TEXT,
        content TEXT NOT NULL,
        embedding_json jsonb NOT NULL,
        content_tsv tsvector,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
  }

  // Lookup/scope indexes and the GIN that backs the lexical half — for BOTH
  // variants. These used to be duplicated inside each branch, and the two copies
  // drifted: the jsonb branch never created `idx_rag_content_tsv`, even though a
  // store with no vector column is exactly the one `ragHybridSearch` forces onto
  // lexical-only ranking, so its every query sequential-scanned the table it was
  // supposed to search by index. Declared once here so the two cannot disagree
  // again, mirroring `ensureGlobalKbSchema`.
  await conn.pg.unsafe(`CREATE INDEX IF NOT EXISTS idx_rag_task_id ON ${RAG_TABLE} (task_id)`);
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_rag_repository_id ON ${RAG_TABLE} (repository_id)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_rag_source_section ON ${RAG_TABLE} (source_path, section_id, chunk_index)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_rag_source_type ON ${RAG_TABLE} (source_type)`,
  );
  await conn.pg.unsafe(
    `CREATE INDEX IF NOT EXISTS idx_rag_content_tsv ON ${RAG_TABLE} USING GIN (content_tsv)`,
  );

  await dedupeAndEnforceRepoUniqueness(conn);

  // tsvector auto-update trigger. Three parts, and the last two are why code
  // identifiers are findable at all: Postgres' text-search PARSER splits
  // snake_case before any dictionary runs, so `to_tsvector` alone stores
  // `pdf_generator` as `pdf` + `generat` and the lexical half can only ever match
  // common English words. `array_to_tsvector` bypasses the parser and stores the
  // whole identifier; the sentinel marks the row as built by THIS body so
  // backfillIdentifierTsv can find the rows that still need it.
  //
  // CREATE OR REPLACE, and ensureRagSchema runs at the start of every workflow
  // task (02-pre-rag-sync), so a change here upgrades every reachable store on
  // its own — no version marker, no migration.
  await conn.pg.unsafe(`
    CREATE OR REPLACE FUNCTION update_content_tsv() RETURNS trigger AS $$
    BEGIN
      NEW.content_tsv := to_tsvector('english', COALESCE(NEW.content, ''))
        || ${identifierTsvSql("COALESCE(NEW.content, '')")}
        || array_to_tsvector(ARRAY['${IDENTIFIER_TSV_SENTINEL}']);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Create trigger if not exists (check pg_trigger catalog)
  const triggerExists = await conn.pg.unsafe(`
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_content_tsv'
  `);
  if (triggerExists.length === 0) {
    await conn.pg.unsafe(`
      CREATE TRIGGER trg_content_tsv
        BEFORE INSERT OR UPDATE ON ${RAG_TABLE}
        FOR EACH ROW EXECUTE FUNCTION update_content_tsv()
    `);
  }

  await backfillIdentifierTsv(conn);

  return { usedPgvector, tableName: RAG_TABLE };
}

/** Rows written before the trigger emitted identifier lexemes keep the old
 *  tsvector forever unless something rewrites them, and nothing does: the
 *  incremental differ skips a chunk whose `chunk_hash` is unchanged
 *  (`workflow/_rag-index.ts`), and a change to how `content_tsv` is DERIVED
 *  leaves `content` — and therefore the hash — identical. So the trigger alone
 *  would upgrade new rows only, and every already-indexed repo would keep a
 *  half-and-half index whose misses are silent.
 *
 *  Same shape as dedupeAndEnforceRepoUniqueness below: it piggybacks the per-run
 *  schema sweep rather than getting its own entry point, warns rather than
 *  throws, and keeps no "applied" record. Convergence is structural instead —
 *  `SET content = content` fires the BEFORE UPDATE trigger, which stamps the
 *  sentinel, and a stamped row never matches the predicate again, so a
 *  fully-upgraded store makes this a no-op.
 *
 *  Capped per invocation because this runs inside a step that gates every
 *  workflow task: a large store finishes over the next few syncs instead of
 *  making one task wait for the whole rewrite. */
const IDENTIFIER_BACKFILL_BATCH = 2_000;
const IDENTIFIER_BACKFILL_MAX_ROWS = 40_000;

async function backfillIdentifierTsv(conn: RagConnection): Promise<void> {
  try {
    let total = 0;
    while (total < IDENTIFIER_BACKFILL_MAX_ROWS) {
      const result = await conn.pg.unsafe(
        `UPDATE ${RAG_TABLE} SET content = content
           WHERE id IN (
             SELECT id FROM ${RAG_TABLE}
             WHERE content_tsv IS NULL OR NOT (content_tsv @@ $1::tsquery)
             LIMIT $2
           )`,
        [IDENTIFIER_TSV_SENTINEL, IDENTIFIER_BACKFILL_BATCH],
      );
      const rows = result.count ?? 0;
      total += rows;
      if (rows < IDENTIFIER_BACKFILL_BATCH) break;
    }
    if (total > 0) {
      log.info({ rows: total }, 'backfilled identifier lexemes into content_tsv');
    }
  } catch (err) {
    // Never fails the caller: a stale lexical index is a degraded search, while a
    // throw here would break onboarding and every workflow task on the repo.
    log.warn({ err }, 'identifier tsv backfill failed; lexical identifier search may be stale');
  }
}

/** One-time migration: collapse duplicate chunk rows keyed by
 *  `(repository_id, source_path, section_id, chunk_index)`, keeping the most
 *  recently inserted one (highest created_at, ties broken by id). Then enforce
 *  a partial UNIQUE INDEX so future inserts cannot recreate duplicates. The
 *  index is partial — rows with `repository_id IS NULL` are allowed to
 *  coexist, since legacy or repo-less invocations write nulls and a unique
 *  constraint on null treats every null as distinct anyway.
 *
 *  Pre-fix RAG inserts keyed dedup by `task_id`, so every workflow task
 *  re-ingested the same content under a new task_id, ballooning the table.
 *  Running this once on a populated DB cuts the row count to the steady-state
 *  per-repo set; subsequent runs become no-ops because the unique index is
 *  in place. */
async function dedupeAndEnforceRepoUniqueness(conn: RagConnection): Promise<void> {
  try {
    const deleted = await conn.pg.unsafe(
      `DELETE FROM ${RAG_TABLE} a
       USING ${RAG_TABLE} b
       WHERE a.repository_id IS NOT NULL
         AND b.repository_id IS NOT NULL
         AND a.repository_id = b.repository_id
         AND a.source_path = b.source_path
         AND a.section_id = b.section_id
         AND a.chunk_index = b.chunk_index
         AND (a.created_at < b.created_at
              OR (a.created_at = b.created_at AND a.id < b.id))`,
    );
    if (deleted.count > 0) {
      log.info({ deleted: deleted.count }, 'collapsed duplicate rag rows by repository_id');
    }
  } catch (err) {
    log.warn({ err }, 'rag dedup migration failed; unique index creation may follow-fail');
  }

  try {
    await conn.pg.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_rag_repo_source_section_chunk
         ON ${RAG_TABLE} (repository_id, source_path, section_id, chunk_index)
         WHERE repository_id IS NOT NULL`,
    );
  } catch (err) {
    log.warn({ err }, 'rag unique index creation failed — duplicate rows may still slip through');
  }
}

/* ------------------------------------------------------------------ */
/* Repository cleanup                                                  */
/* ------------------------------------------------------------------ */

/**
 * Drop the per-project internal RAG database for each `projectName` after a
 * repository has been deleted. A database is dropped only when no surviving
 * task targets the same project name with `ragMode='internal'` — otherwise
 * another (non-deleted) repo would lose its embeddings.
 *
 * External and ddev RAG modes are NEVER touched: they live on infrastructure
 * Haive does not own (a customer DDEV project, a customer-supplied postgres).
 * Caller is responsible for filtering `projectNames` to only those that
 * originated from `ragMode='internal'` tasks of the deleted repo.
 */
export async function cleanupRagForRepository(
  haiveDb: Database,
  payload: { repositoryId: string; userId: string; projectNames: string[] },
): Promise<{ dropped: string[]; kept: string[] }> {
  const dropped: string[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();

  for (const rawName of payload.projectNames) {
    if (typeof rawName !== 'string' || rawName.trim().length === 0) continue;
    const projectName = rawName.trim();
    const dbName = ragDatabaseName(projectName);
    if (seen.has(dbName)) continue;
    seen.add(dbName);

    // Collision check: a surviving task (any user, any repo) that ran step 04
    // with ragMode='internal' AND step 01-env-detect with the same project
    // name keeps the database alive. Repo deletion sets `tasks.repository_id`
    // to NULL via FK ON DELETE SET NULL, so orphaned tasks of the deleted
    // repo are still in the table — but they no longer represent a live
    // consumer. Filter them out via `repository_id IS NOT NULL`.
    let hasCollision = false;
    try {
      const rows = (await haiveDb.execute(sql`
        SELECT 1
        FROM task_steps env_step
        JOIN task_steps tooling_step ON tooling_step.task_id = env_step.task_id
        JOIN tasks t ON t.id = env_step.task_id
        WHERE env_step.step_id = '01-env-detect'
          AND tooling_step.step_id = '04-tooling-infrastructure'
          AND t.repository_id IS NOT NULL
          AND env_step.detect_output -> 'data' -> 'project' ->> 'name' = ${projectName}
          AND tooling_step.output -> 'tooling' ->> 'ragMode' = 'internal'
        LIMIT 1
      `)) as unknown as unknown[];
      hasCollision = Array.isArray(rows) && rows.length > 0;
    } catch (err) {
      log.warn({ err, dbName, projectName }, 'collision check failed; keeping rag database');
      kept.push(dbName);
      continue;
    }

    if (hasCollision) {
      log.info(
        { dbName, projectName, repositoryId: payload.repositoryId },
        'rag database kept — surviving task references the same project name',
      );
      kept.push(dbName);
      continue;
    }

    try {
      // Terminate any active connections to the per-project DB before drop.
      // Quote the database name to survive non-identifier characters even
      // though sanitizeDbName already constrains it.
      const escaped = dbName.replace(/'/g, "''");
      await haiveDb.execute(
        sql.raw(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escaped}' AND pid <> pg_backend_pid()`,
        ),
      );
      await haiveDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
      log.info(
        { dbName, projectName, repositoryId: payload.repositoryId },
        'dropped per-project rag database after repo deletion',
      );
      dropped.push(dbName);
    } catch (err) {
      log.warn({ err, dbName, projectName }, 'failed to drop rag database (non-fatal)');
      kept.push(dbName);
    }
  }

  return { dropped, kept };
}
