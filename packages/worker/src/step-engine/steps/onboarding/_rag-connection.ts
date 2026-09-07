import { sql } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  IDENTIFIER_TSV_SENTINEL,
  RAG_TABLE,
  identifierTsvSql,
  openExistingRagDatabase,
  ragDatabaseName,
  type RagConnection,
} from '@haive/shared/rag';
import { repoRagIdentityFromMirror } from '@haive/shared/global-kb';

// Connection resolution + types moved to @haive/shared/rag so the API query
// path can reuse them without importing the worker. Re-exported here so
// existing worker imports keep resolving unchanged. The schema-creation,
// dedup, and cleanup helpers below are populate/cleanup-side and stay worker-local.
export {
  RAG_TABLE,
  ragDatabaseName,
  resolveRagConnection,
  resolveToolingOllamaUrl,
} from '@haive/shared/rag';
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
 * Reclaim the per-project internal RAG storage of a deleted repository.
 *
 * Two halves, because they answer different questions. RECLAMATION deletes the deleted
 * repo's own rows — the only mechanism by which a database shared with a co-tenant can
 * shrink when one of them leaves. Then three independent KEEPERS decide whether the
 * database itself may go; it is dropped only when ALL of them are false:
 *
 *   1. rows remain in the table,
 *   2. a SURVIVING repository resolves to this same database,
 *   3. another backend is connected to it.
 *
 * This replaces a single collision query over `task_steps`, which was wrong in three
 * separate ways and destroyed data. It required a surviving TASK carrying both an
 * `01-env-detect` project name and an `04-tooling-infrastructure` `ragMode='internal'`,
 * so: a repo whose config lives only in the repository mirror columns (no onboarding
 * task at all — what `importHaiveDataMirror` produces) was invisible to it; deleting a
 * repo NULLs its own tasks' `repository_id` via the FK, and the query's
 * `repository_id IS NOT NULL` filter then discarded the last evidence; and it compared
 * RAW project names while the DROP targeted the SANITISED database name, so a surviving
 * `elmont.rs` did not protect the store that deleting `elmont-rs` dropped. MEASURED on a
 * live install: two repos sharing one database, and deleting either destroyed 9,278
 * chunks belonging to the other.
 *
 * Keeper 2 is that check done right — asked of `repositories` rather than `tasks`, and
 * compared on `ragDatabaseName()`. Keeper 1 alone would NOT be enough: `10-rag-populate`
 * in full-rebuild mode deletes a repo's rows and re-inserts them over the whole embedding
 * run, so an emptiness test taken during that window would drop the store out from under
 * it. Keeper 3 closes the same window from the other side, which is also why the old
 * `pg_terminate_backend` is gone: clearing those backends is precisely the wrong move.
 *
 * External and ddev RAG modes are NEVER touched: they live on infrastructure Haive does
 * not own. The caller filters `projectNames` to `ragMode='internal'` names of the deleted
 * repo.
 *
 * Never throws, and every uncertainty resolves to `kept`: a leaked database costs disk,
 * a wrongly dropped one cannot be recovered.
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

    // Keeper 2, asked BEFORE anything is written: does a surviving repository resolve to
    // this same database? Compared on the sanitised name, since several raw project names
    // map onto one database.
    let claimedBySurvivor: boolean;
    try {
      claimedBySurvivor = await isRagDatabaseClaimed(haiveDb, dbName);
    } catch (err) {
      log.warn({ err, dbName, projectName }, 'survivor check failed; keeping rag database');
      kept.push(dbName);
      continue;
    }

    // Reclamation still runs when a survivor claims the database — the deleted repo's rows
    // are dead weight either way, and this is the only thing that shrinks a shared store.
    let rowsRemain = true;
    let deletedRows = 0;
    let conn: RagConnection | null = null;
    try {
      conn = await openExistingRagDatabase(haiveDb, dbName);
      if (!conn) {
        // Nothing on disk. `DROP DATABASE IF EXISTS` would be a no-op, and opening through
        // resolveRagConnection would have CREATED it.
        log.info({ dbName, projectName }, 'no per-project rag database to clean');
        kept.push(dbName);
        continue;
      }
      const removed = await conn.pg.unsafe(`DELETE FROM ${RAG_TABLE} WHERE repository_id = $1`, [
        payload.repositoryId,
      ]);
      deletedRows = removed.count ?? 0;
      const remaining = (await conn.pg.unsafe(
        `SELECT 1 FROM ${RAG_TABLE} LIMIT 1`,
      )) as unknown as unknown[];
      rowsRemain = Array.isArray(remaining) && remaining.length > 0;
      // Dead tuples and HNSW tombstones the old whole-database DROP used to reclaim in one
      // go are now the surviving tenant's to pay for on every query. Best-effort, and it
      // cannot run inside a transaction — which is another reason nothing here is wrapped.
      if (deletedRows > 0 && rowsRemain) {
        await conn.pg.unsafe(`VACUUM ${RAG_TABLE}`).catch(() => {});
      }
    } catch (err) {
      log.warn({ err, dbName, projectName }, 'rag row cleanup failed; keeping rag database');
      kept.push(dbName);
      continue;
    } finally {
      // Must resolve before any DROP: our own pool is a connected backend.
      if (conn) await conn.close().catch(() => {});
    }

    if (rowsRemain || claimedBySurvivor) {
      log.info(
        {
          dbName,
          projectName,
          repositoryId: payload.repositoryId,
          deletedRows,
          rowsRemain,
          claimedBySurvivor,
        },
        'rag database kept — still in use',
      );
      kept.push(dbName);
      continue;
    }

    // Keeper 3, last because it is the most perishable: anyone else connected right now is
    // reason enough to leave it alone. Asked after our own pool closed, or we would see
    // ourselves.
    try {
      const others = (await haiveDb.execute(
        sql`SELECT 1 FROM pg_stat_activity WHERE datname = ${dbName} AND pid <> pg_backend_pid() LIMIT 1`,
      )) as unknown as unknown[];
      if (Array.isArray(others) && others.length > 0) {
        log.info({ dbName, projectName }, 'rag database kept — another backend is connected');
        kept.push(dbName);
        continue;
      }
    } catch (err) {
      log.warn({ err, dbName, projectName }, 'connection check failed; keeping rag database');
      kept.push(dbName);
      continue;
    }

    if (await dropRagDatabase(haiveDb, dbName, projectName, payload.repositoryId)) {
      dropped.push(dbName);
    } else {
      kept.push(dbName);
    }
  }

  return { dropped, kept };
}

/** Keeper 2: does any SURVIVING repository resolve to this database?
 *
 *  Reads `repositories` rather than `tasks` — repository rows are hard-deleted, so
 *  "present" IS "surviving", where a task's `repository_id` is merely NULLed and its
 *  step rows outlive the repo they described. Resolution goes through the shared mirror
 *  parser so a repo restored from `.haive-data/` (which has no onboarding task at all) is
 *  visible here; a repo with no mirror falls back to its onboarding task's step rows.
 *  Comparison is on `ragDatabaseName`, because that is what the DROP targets. */
async function isRagDatabaseClaimed(haiveDb: Database, dbName: string): Promise<boolean> {
  const repos = await haiveDb.query.repositories.findMany({
    columns: { id: true, onboardingTooling: true, onboardingEnvironment: true },
  });

  for (const repo of repos) {
    const identity = repoRagIdentityFromMirror(repo.onboardingTooling, repo.onboardingEnvironment);
    if (identity) {
      if (identity.ragMode === 'internal' && ragDatabaseName(identity.projectName) === dbName) {
        return true;
      }
      continue;
    }
    // No mirror: fall back to this repo's onboarding task, the pre-mirror shape.
    const rows = (await haiveDb.execute(sql`
      SELECT env_step.detect_output -> 'data' -> 'project' ->> 'name' AS project_name
      FROM task_steps env_step
      JOIN task_steps tooling_step ON tooling_step.task_id = env_step.task_id
      JOIN tasks t ON t.id = env_step.task_id
      WHERE t.repository_id = ${repo.id}
        AND env_step.step_id = '01-env-detect'
        AND tooling_step.step_id = '04-tooling-infrastructure'
        AND tooling_step.output -> 'tooling' ->> 'ragMode' = 'internal'
    `)) as unknown as Array<{ project_name: string | null }>;
    for (const row of rows) {
      const name = row.project_name?.trim();
      if (name && ragDatabaseName(name) === dbName) return true;
    }
  }

  return false;
}

/** Drop the database, retrying once on `55006 object_in_use`: postgres.js closing its
 *  socket is not synchronous with the server tearing the backend down, so a drop issued
 *  immediately after `pg.end()` can still lose that race. Returns whether it went. */
async function dropRagDatabase(
  haiveDb: Database,
  dbName: string,
  projectName: string,
  repositoryId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await haiveDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
      log.info(
        { dbName, projectName, repositoryId },
        'dropped per-project rag database after repo deletion',
      );
      return true;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '55006' && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      log.warn({ err, dbName, projectName }, 'failed to drop rag database (non-fatal)');
      return false;
    }
  }
  return false;
}
