import { createHash } from 'node:crypto';
import { type Database } from '@haive/database';
import {
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  type GlobalKbConnection,
  type GlobalKbSettings,
} from './connection.js';
import { ensureGlobalKbSchema } from './ensure-schema.js';
import { createGlobalKbDb, type GlobalKbDb } from './schema.js';

// Schema DDL is memoized per process and store: the first call for a store ensures it, calls
// meanwhile wait for that one, and later calls skip it. The settings can switch stores at runtime.
const schemaReady = new Map<string, Promise<unknown>>();

function storeKey(settings: GlobalKbSettings): string {
  if (settings.mode !== 'external') return settings.mode;
  return createHash('sha256')
    .update(settings.connectionString ?? '')
    .digest('hex');
}

export interface GlobalKbContext {
  conn: GlobalKbConnection;
  db: GlobalKbDb;
  settings: GlobalKbSettings;
}

/** Open the global KB store, ensure its schema once per process and store, run `fn`, then
 *  close the connection. Mirrors the rag route's open/close-per-call pattern;
 *  used by both the API CRUD route and the worker sync job. `haiveDb` is only
 *  needed to CREATE the dedicated DB in `internal` mode. */
export async function withGlobalKb<T>(
  haiveDb: Database,
  fn: (ctx: GlobalKbContext) => Promise<T>,
): Promise<T> {
  const settings = await resolveGlobalKbSettings();
  const conn = await resolveGlobalKbConnection(settings, haiveDb);
  try {
    const key = storeKey(settings);
    let ready = schemaReady.get(key);
    if (!ready) {
      ready = ensureGlobalKbSchema(conn).catch((err: unknown) => {
        schemaReady.delete(key);
        throw err;
      });
      schemaReady.set(key, ready);
    }
    await ready;
    const db = createGlobalKbDb(conn.pg);
    return await fn({ conn, db, settings });
  } finally {
    await conn.close().catch(() => {});
  }
}
