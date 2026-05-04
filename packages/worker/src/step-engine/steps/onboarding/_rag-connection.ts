import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'rag-connection' });

export const RAG_TABLE = 'ai_rag_embeddings';

export type RagMode = 'internal' | 'external' | 'ddev' | 'none';

export interface RagToolingPrefs {
  ragMode: RagMode;
  ragConnectionString: string | null;
  ollamaUrl: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
}

export interface RagConnection {
  mode: RagMode;
  pg: postgres.Sql;
  embeddingDimensions: number;
  close: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Database name helpers                                               */
/* ------------------------------------------------------------------ */

function sanitizeDbName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

export function ragDatabaseName(projectName: string): string {
  return `haive_rag_${sanitizeDbName(projectName || 'default')}`;
}

/* ------------------------------------------------------------------ */
/* Connection resolvers                                                */
/* ------------------------------------------------------------------ */

async function resolveInternal(
  haiveDb: Database,
  projectName: string,
  embeddingDimensions: number,
): Promise<RagConnection> {
  const dbName = ragDatabaseName(projectName);

  try {
    const rows = (await haiveDb.execute(
      sql.raw(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`),
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) {
      await haiveDb.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
      log.info({ dbName }, 'created per-project RAG database');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists')) {
      throw err;
    }
  }

  const haiveUrl = process.env.DATABASE_URL;
  if (!haiveUrl) throw new Error('DATABASE_URL not set');
  const url = new URL(haiveUrl);
  url.pathname = `/${dbName}`;
  const connStr = url.toString();

  const pg = postgres(connStr, { max: 5 });
  return {
    mode: 'internal',
    pg,
    embeddingDimensions,
    close: async () => {
      await pg.end();
    },
  };
}

function resolveExternal(connectionString: string, embeddingDimensions: number): RagConnection {
  const pg = postgres(connectionString, { max: 5 });
  return {
    mode: 'external',
    pg,
    embeddingDimensions,
    close: async () => {
      await pg.end();
    },
  };
}

function resolveDdev(connectionString: string | null, embeddingDimensions: number): RagConnection {
  const connStr = connectionString ?? 'postgres://db:db@host.docker.internal:5432/db';
  return resolveExternal(connStr, embeddingDimensions);
}

export async function resolveRagConnection(
  prefs: RagToolingPrefs,
  haiveDb: Database,
  projectName: string,
): Promise<RagConnection | null> {
  switch (prefs.ragMode) {
    case 'internal':
      return resolveInternal(haiveDb, projectName, prefs.embeddingDimensions);
    case 'external':
      if (!prefs.ragConnectionString) {
        throw new Error('external ragMode requires ragConnectionString');
      }
      return resolveExternal(prefs.ragConnectionString, prefs.embeddingDimensions);
    case 'ddev':
      return resolveDdev(prefs.ragConnectionString, prefs.embeddingDimensions);
    case 'none':
      return null;
    default:
      return null;
  }
}

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

    // Indexes
    await conn.pg.unsafe(`CREATE INDEX IF NOT EXISTS idx_rag_task_id ON ${RAG_TABLE} (task_id)`);
    await conn.pg.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_source_section ON ${RAG_TABLE} (source_path, section_id, chunk_index)`,
    );
    await conn.pg.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_source_type ON ${RAG_TABLE} (source_type)`,
    );
    await conn.pg.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_content_tsv ON ${RAG_TABLE} USING GIN (content_tsv)`,
    );

    // HNSW index with halfvec cast (supports >2000 dims)
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
    await conn.pg.unsafe(`CREATE INDEX IF NOT EXISTS idx_rag_task_id ON ${RAG_TABLE} (task_id)`);
    await conn.pg.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_source_section ON ${RAG_TABLE} (source_path, section_id, chunk_index)`,
    );
    await conn.pg.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_source_type ON ${RAG_TABLE} (source_type)`,
    );
  }

  // tsvector auto-update trigger
  await conn.pg.unsafe(`
    CREATE OR REPLACE FUNCTION update_content_tsv() RETURNS trigger AS $$
    BEGIN
      NEW.content_tsv := to_tsvector('english', COALESCE(NEW.content, ''));
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

  return { usedPgvector, tableName: RAG_TABLE };
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
