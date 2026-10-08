import { createHash } from 'node:crypto';
import { type Database } from '@haive/database';
import {
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  type GlobalKbConnection,
  type GlobalKbSettings,
} from './connection.js';
import { ensureGlobalKbSchema } from './ensure-schema.js';
import { GlobalKbDeadlineError } from './errors.js';
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

/** Bounds for one call. Absent, the connection keeps its own limits, which the sync job and the api
 *  rely on: their calls embed and wait on locks. */
export interface GlobalKbCallOptions {
  /** Seconds postgres.js allows for TCP, TLS, startup and auth. */
  connectTimeoutSeconds?: number;
  /** Past it the pool is destroyed and the call rejects with `GlobalKbDeadlineError`; nothing else
   *  bounds a socket that goes silent once connected. */
  deadlineMs?: number;
}

async function openAndRun<T>(
  haiveDb: Database,
  fn: (ctx: GlobalKbContext) => Promise<T>,
  opts: GlobalKbCallOptions,
  onOpen?: (conn: GlobalKbConnection) => void,
): Promise<T> {
  const settings = await resolveGlobalKbSettings();
  const conn = await resolveGlobalKbConnection(settings, haiveDb, {
    connectTimeoutSeconds: opts.connectTimeoutSeconds,
    // A pool destroyed at the deadline while that query is pending rejects it with nobody awaiting it.
    ...(opts.deadlineMs === undefined ? {} : { fetchTypes: false }),
  });
  onOpen?.(conn);
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

/** Open the global KB store, ensure its schema once per process and store, run `fn`, then
 *  close the connection. Mirrors the rag route's open/close-per-call pattern;
 *  used by both the API CRUD route and the worker sync job. `haiveDb` is only
 *  needed to CREATE the dedicated DB in `internal` mode. */
export async function withGlobalKb<T>(
  haiveDb: Database,
  fn: (ctx: GlobalKbContext) => Promise<T>,
  opts: GlobalKbCallOptions = {},
): Promise<T> {
  const { deadlineMs } = opts;
  if (deadlineMs === undefined) return openAndRun(haiveDb, fn, opts);

  let open: GlobalKbConnection | null = null;
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const destroy = (conn: GlobalKbConnection | null): void => {
    void conn?.pg.end({ timeout: 0 }).catch(() => {});
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new GlobalKbDeadlineError(deadlineMs));
      destroy(open);
    }, deadlineMs);
  });
  const work = openAndRun(haiveDb, fn, opts, (conn) => {
    open = conn;
    if (expired) destroy(conn);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
