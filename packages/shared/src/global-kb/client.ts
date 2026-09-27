import { type Database } from '@haive/database';
import {
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  type GlobalKbConnection,
  type GlobalKbSettings,
} from './connection.js';
import { ensureGlobalKbSchema } from './ensure-schema.js';
import { createGlobalKbDb, type GlobalKbDb } from './schema.js';

// Schema DDL is memoized per process: the first withGlobalKb call ensures it, concurrent first
// calls wait for that one, and later calls skip it (the tables persist in the DB). A process
// restart re-ensures, which is the only time a reconfigured external DB needs it.
let schemaReady: Promise<void> | null = null;

// Every process and install sharing this store ensures it too, and two ensures at once collide on
// the catalog ("tuple concurrently updated"), so each runs under one session lock.
const SCHEMA_LOCK_KEY = 'haive:global-kb-schema';

async function ensureSchemaUnderLock(conn: GlobalKbConnection): Promise<void> {
  const reserved = await conn.pg.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(hashtext(${SCHEMA_LOCK_KEY}))`;
    try {
      await ensureGlobalKbSchema({ ...conn, pg: reserved });
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtext(${SCHEMA_LOCK_KEY}))`;
    }
  } finally {
    reserved.release();
  }
}

export interface GlobalKbContext {
  conn: GlobalKbConnection;
  db: GlobalKbDb;
  settings: GlobalKbSettings;
}

/** Open the global KB store, ensure its schema once per process, run `fn`, then
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
    schemaReady ??= ensureSchemaUnderLock(conn).catch((err: unknown) => {
      schemaReady = null;
      throw err;
    });
    await schemaReady;
    const db = createGlobalKbDb(conn.pg);
    return await fn({ conn, db, settings });
  } finally {
    await conn.close().catch(() => {});
  }
}
