import { databaseName } from '../naming/index.js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { IN_STACK_OLLAMA_URL } from '../constants/index.js';
import { logger } from '../logger/index.js';

const log = logger.child({ module: 'rag-connection' });

export const RAG_TABLE = 'ai_rag_embeddings';

/** The `source_type` values that carry PROJECT KNOWLEDGE, as opposed to code.
 *  Named positively rather than as "not code" because a fifth value exists that
 *  is neither: `task` rows (`workflow/_task-embedding.ts`) hold one embedding per
 *  task, keyed by task UUID rather than a file, for the effort estimator alone.
 *  They have no counter in `logRagQuery`, so one surfacing in an agent's results
 *  would be an invisible hit. */
export const KNOWLEDGE_SOURCE_TYPES = ['kb', 'runbook', 'learning'] as const;

/** The `source_type` of those per-task rows. Declared here rather than in the worker
 *  (`workflow/_task-embedding.ts` imports it from here) so the writer and the search
 *  that must exclude them cannot drift.
 *
 *  `ragHybridSearch` filters them out of every candidate CTE. They are keyed by task
 *  UUID rather than a repo file, so they are never an answer to a retrieval query —
 *  MEASURED before the filter existed: on a repo with 2 such rows they took ranks 1
 *  and 2 of EVERY page, consuming 2 of a `top_k` of 8-12 and appearing in no column
 *  of the RAG panel, whose per-type counts consequently never summed to `hit_count`.
 *  The effort estimator does not go through this path — it reads them with its own
 *  `source_type = 'task'` query — so excluding them here costs it nothing.
 *
 *  Written as "not task" rather than an allow-list of the retrievable four: the
 *  invariant is that these rows are not retrievable content, and an allow-list would
 *  silently drop any source type added later. */
export const TASK_SOURCE_TYPE = 'task';

/** Resolve the embedding endpoint from a stored tooling object, re-deriving it when the
 *  committed mirror dropped it.
 *
 *  `ollamaUrl` is one of ONBOARDING_TOOLING_INFRA_KEYS, stripped from
 *  `.haive-data/tooling.json` at 12-post-onboarding because it is machine-specific — but
 *  `ollamaMode` survives, and for 'internal' the URL is a docker service name that is the
 *  same on every install. `04-tooling-infrastructure` already derives it that way on the
 *  origin machine; nothing did so on a machine that RESTORED the mirror, so `useOllama`
 *  was false and every chunk was hash-embedded. MEASURED on such a repo: all 9,278 chunks
 *  were hash vectors, best dense similarity for a real query embedding 0.0707 against
 *  0.7273 on its non-restored twin, and identical-content chunks across the two
 *  correlating at ~0.01.
 *
 *  `derived` is the load-bearing half of the answer, not a diagnostic: it is true exactly
 *  when the stored tooling had no URL, which means every prior sync that read this tooling
 *  ran without an endpoint and therefore hashed. It is the only provenance signal for an
 *  index built out of hash vectors — nothing is recorded per row — so the indexer uses it
 *  to force one re-embed rather than leaving a poisoned store that content hashing would
 *  otherwise preserve forever.
 *
 *  'external' carries a user-typed, genuinely machine-specific URL and is NOT re-derived. */
export function resolveToolingOllamaUrl(tooling: { ollamaUrl?: unknown; ollamaMode?: unknown }): {
  url: string | null;
  derived: boolean;
} {
  const stored = typeof tooling.ollamaUrl === 'string' ? tooling.ollamaUrl : '';
  if (stored) return { url: stored, derived: false };
  if (tooling.ollamaMode === 'internal') return { url: IN_STACK_OLLAMA_URL, derived: true };
  return { url: null, derived: false };
}

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
  return databaseName('rag', sanitizeDbName(projectName || 'default'));
}

/* ------------------------------------------------------------------ */
/* Connection resolvers                                                */
/* ------------------------------------------------------------------ */

/** The per-project database's connection string: DATABASE_URL with the path swapped.
 *  `url.search` is preserved deliberately — an install that carries `sslmode` or any
 *  other parameter there must carry it to the per-project store too. */
function internalRagUrl(dbName: string): string {
  const haiveUrl = process.env.DATABASE_URL;
  if (!haiveUrl) throw new Error('DATABASE_URL not set');
  const url = new URL(haiveUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** True when a database of that name exists. Kept separate from the create branch so
 *  callers that must NOT create one can ask the same question. */
async function ragDatabaseExists(haiveDb: Database, dbName: string): Promise<boolean> {
  const rows = (await haiveDb.execute(
    sql.raw(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`),
  )) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/** Open an EXISTING per-project database, or null when there is none.
 *
 *  The distinction from `resolveRagConnection` is the whole point: its internal branch
 *  CREATEs the database when absent, which is right for indexing and catastrophic for
 *  cleanup — connecting through it to decide whether to drop a store would conjure the
 *  very store being dropped. `max: 1` because the one caller opens this to run two
 *  statements and then has to wait for the pool to drain before `DROP DATABASE` can
 *  succeed; five backends is five things to close. */
export async function openExistingRagDatabase(
  haiveDb: Database,
  dbName: string,
  embeddingDimensions = 2560,
): Promise<RagConnection | null> {
  if (!(await ragDatabaseExists(haiveDb, dbName))) return null;

  const pg = postgres(internalRagUrl(dbName), { max: 1 });
  return {
    mode: 'internal',
    pg,
    embeddingDimensions,
    // A timeout because postgres.js's default end() waits indefinitely for in-flight
    // queries, and the caller cannot drop the database until this resolves.
    close: async () => {
      await pg.end({ timeout: 5 });
    },
  };
}

async function resolveInternal(
  haiveDb: Database,
  projectName: string,
  embeddingDimensions: number,
): Promise<RagConnection> {
  const dbName = ragDatabaseName(projectName);

  try {
    if (!(await ragDatabaseExists(haiveDb, dbName))) {
      await haiveDb.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
      log.info({ dbName }, 'created per-project RAG database');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists')) {
      throw err;
    }
  }

  const pg = postgres(internalRagUrl(dbName), { max: 5 });
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
      // No fallback DSN. This used to guess `db:db@host.docker.internal:5432/db`
      // — DDEV's in-container credentials — which cannot reach a DDEV database
      // from here: DDEV binds it to a RANDOM loopback-only host port. On any
      // install that publishes 5432 the guess instead reached haive's own
      // postgres and failed with `password authentication failed for user "db"`
      // at 10-rag-populate, hours into onboarding.
      if (!prefs.ragConnectionString) {
        throw new Error(
          "ddev ragMode requires ragConnectionString — DDEV publishes its database on a random loopback port, so there is no address to guess (`ddev describe` prints it). Use RAG mode 'internal' to store embeddings in haive's own postgres instead.",
        );
      }
      return resolveExternal(prefs.ragConnectionString, prefs.embeddingDimensions);
    case 'none':
      return null;
    default:
      return null;
  }
}
