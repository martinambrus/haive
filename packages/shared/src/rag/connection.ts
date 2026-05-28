import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { logger } from '../logger/index.js';

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
