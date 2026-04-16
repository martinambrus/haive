import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
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
/* Task cleanup (delete RAG rows for a cancelled/failed task)          */
/* ------------------------------------------------------------------ */

/**
 * Delete all RAG rows for a given task. Used during task cancellation.
 * Resolves the RAG connection from onboarding step 04 output, connects,
 * and deletes rows where task_id matches. Silently skips if RAG is not
 * configured or connection fails.
 */
export async function cleanupRagForTask(haiveDb: Database, taskId: string): Promise<number> {
  try {
    // Load step 04 tooling prefs from the task
    const stepRow = await haiveDb
      .select()
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, taskId),
          eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
        ),
      )
      .limit(1);
    const output = stepRow[0]?.output as { tooling?: Record<string, unknown> } | null;
    if (!output?.tooling) return 0;

    const t = output.tooling;
    const ragMode = (t.ragMode as string) ?? 'none';
    if (ragMode === 'none') return 0;

    const prefs: RagToolingPrefs = {
      ragMode: ragMode as RagMode,
      ragConnectionString: (t.ragConnectionString as string) || null,
      ollamaUrl: null,
      embeddingModel: null,
      embeddingDimensions: typeof t.embeddingDimensions === 'number' ? t.embeddingDimensions : 2560,
    };

    // Get project name from env-detect
    const envRow = await haiveDb
      .select()
      .from(schema.taskSteps)
      .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-env-detect')))
      .limit(1);
    const envDetect = envRow[0]?.detectOutput as { data?: { project?: { name?: string } } } | null;
    const projectName = envDetect?.data?.project?.name ?? 'default';

    const conn = await resolveRagConnection(prefs, haiveDb, projectName);
    if (!conn) return 0;

    try {
      // Table might not exist yet if task was cancelled early
      const result = await conn.pg.unsafe(`DELETE FROM ${RAG_TABLE} WHERE task_id = $1`, [taskId]);
      const count = result.count;
      if (count > 0) {
        log.info({ taskId, count }, 'cleaned up RAG rows for cancelled task');
      }
      return count;
    } catch (err) {
      // Table doesn't exist — nothing to clean
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not exist')) return 0;
      throw err;
    } finally {
      await conn.close();
    }
  } catch (err) {
    log.warn({ err, taskId }, 'rag cleanup for task failed (non-fatal)');
    return 0;
  }
}
