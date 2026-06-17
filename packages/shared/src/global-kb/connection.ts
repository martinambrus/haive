import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { logger } from '../logger/index.js';
import { configService, CONFIG_KEYS } from '../config/config.service.js';
import { secretsService, SECRET_KEYS } from '../config/secrets.service.js';

const log = logger.child({ module: 'global-kb-connection' });

/** Provider mode for the global KB store. Deliberately NOT `RagMode` — `ddev`
 *  and `none` are per-repo-only concepts (plan §4 intro). */
export type GlobalKbMode = 'internal' | 'external';

/** Dedicated DB name when `mode='internal'` (Haive is the provider), created on
 *  the main Postgres host just like a per-project `haive_rag_<project>` DB. */
export const GLOBAL_KB_DB_NAME = 'haive_kb_global';

/** Default embedding model + dimensions when unset, matching the per-repo RAG
 *  defaults in onboarding step 04 so a global KB embeds with the same model. */
const DEFAULT_EMBED_MODEL = 'qwen3-embedding:4b';
const DEFAULT_EMBED_DIMENSIONS = 2560;

/** Default window before a superseded (archived) entry is hard-deleted by the
 *  retention sweep. 0 = keep archived entries forever. */
const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;

/** Instance-level global KB settings resolved from ConfigService + SecretsService. */
export interface GlobalKbSettings {
  enabled: boolean;
  mode: GlobalKbMode;
  namespace: string;
  /** External connection string (secret). Required when `mode='external'`. */
  connectionString: string | null;
  ollamaUrl: string | null;
  embedModel: string | null;
  embeddingDimensions: number;
  /** Days a superseded (archived) entry is kept before the retention sweep
   *  hard-deletes it. 0 = never purge. */
  archiveRetentionDays: number;
}

export interface GlobalKbConnection {
  mode: GlobalKbMode;
  pg: postgres.Sql;
  namespace: string;
  embeddingDimensions: number;
  ollamaUrl: string | null;
  embedModel: string | null;
  close: () => Promise<void>;
}

/** Read the instance-level global KB settings. Non-secret values come from
 *  ConfigService (Redis); the external connection string comes from
 *  SecretsService (encrypted system_secrets). Both singletons must be
 *  initialized by the api/worker boot before this is called. */
export async function resolveGlobalKbSettings(): Promise<GlobalKbSettings> {
  const [
    enabled,
    mode,
    namespace,
    ollamaUrl,
    embedModel,
    embeddingDimensions,
    archiveRetentionDays,
  ] = await Promise.all([
    configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_ENABLED, false),
    configService.get(CONFIG_KEYS.GLOBAL_KB_MODE),
    configService.get(CONFIG_KEYS.GLOBAL_KB_NAMESPACE),
    configService.get(CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL),
    configService.get(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL),
    configService.getNumber(CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS, DEFAULT_EMBED_DIMENSIONS),
    configService.getNumber(
      CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS,
      DEFAULT_ARCHIVE_RETENTION_DAYS,
    ),
  ]);
  const connectionString = await secretsService.get(SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING);
  return {
    enabled,
    mode: mode === 'external' ? 'external' : 'internal',
    namespace: namespace || 'default',
    connectionString: connectionString || null,
    ollamaUrl: ollamaUrl || null,
    embedModel: embedModel || DEFAULT_EMBED_MODEL,
    embeddingDimensions,
    archiveRetentionDays,
  };
}

async function resolveInternal(
  settings: GlobalKbSettings,
  haiveDb: Database,
): Promise<GlobalKbConnection> {
  const dbName = GLOBAL_KB_DB_NAME;

  // Create the dedicated DB on the main host if absent (mirrors the per-project
  // resolveInternal in shared/rag/connection.ts).
  try {
    const rows = (await haiveDb.execute(
      sql.raw(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`),
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) {
      await haiveDb.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
      log.info({ dbName }, 'created internal global KB database');
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

  const pg = postgres(url.toString(), { max: 5 });
  return buildConnection('internal', pg, settings);
}

function resolveExternal(settings: GlobalKbSettings, connectionString: string): GlobalKbConnection {
  const pg = postgres(connectionString, { max: 5 });
  return buildConnection('external', pg, settings);
}

function buildConnection(
  mode: GlobalKbMode,
  pg: postgres.Sql,
  settings: GlobalKbSettings,
): GlobalKbConnection {
  return {
    mode,
    pg,
    namespace: settings.namespace,
    embeddingDimensions: settings.embeddingDimensions,
    ollamaUrl: settings.ollamaUrl,
    embedModel: settings.embedModel,
    close: async () => {
      await pg.end();
    },
  };
}

/** Open a connection to the global KB store. `internal` ensures+connects the
 *  dedicated `haive_kb_global` DB on the main host; `external` connects the
 *  configured central/remote Postgres. Caller owns `close()`. */
export async function resolveGlobalKbConnection(
  settings: GlobalKbSettings,
  haiveDb: Database,
): Promise<GlobalKbConnection> {
  if (settings.mode === 'external') {
    if (!settings.connectionString) {
      throw new Error('external globalKbMode requires the GLOBAL_KB_CONNECTION_STRING secret');
    }
    return resolveExternal(settings, settings.connectionString);
  }
  return resolveInternal(settings, haiveDb);
}
