import { createHash } from 'node:crypto';
import { type Database } from '@haive/database';
import {
  resolveGlobalKbConnection,
  resolveGlobalKbSettings,
  type GlobalKbConnection,
  type GlobalKbSettings,
} from './connection.js';
import { configService, CONFIG_KEYS } from '../config/config.service.js';
import { secretsService, SECRET_KEYS } from '../config/secrets.service.js';
import { backfillGlobalIdentifierTsv, ensureGlobalKbSchema } from './ensure-schema.js';
import { GlobalKbDeadlineError } from './errors.js';
import { createGlobalKbDb, type GlobalKbDb } from './schema.js';

// Schema DDL is memoized per process and store: the first call for a store ensures it, calls
// meanwhile wait for that one, and later calls skip it. The settings can switch stores at runtime.
const schemaReady = new Map<string, Promise<unknown>>();
// Stores whose identifier backfill failed or stopped early in this process: the memoized ensure
// will not run it again, so the reconcile sweep retries it.
const identifierBackfillOwed = new Set<string>();

function noteIdentifierBackfill(key: string, done: boolean): void {
  if (done) identifierBackfillOwed.delete(key);
  else identifierBackfillOwed.add(key);
}

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

/** Bounds for one call, and the settings it opens. Absent, the connection keeps its own limits,
 *  which the sync job and the api rely on: their calls embed and wait on locks. */
export interface GlobalKbCallOptions {
  /** Seconds postgres.js allows for TCP, TLS, startup and auth. */
  connectTimeoutSeconds?: number;
  /** Past it the pool is destroyed and the call rejects with `GlobalKbDeadlineError`; nothing else
   *  bounds a socket that goes silent once connected. */
  deadlineMs?: number;
  /** Settings the caller already read, so what it did with them (a query embed) and the store this
   *  call opens are one snapshot; read afresh when absent. */
  settings?: GlobalKbSettings;
}

async function openAndRun<T>(
  haiveDb: Database,
  fn: (ctx: GlobalKbContext) => Promise<T>,
  opts: GlobalKbCallOptions,
  onOpen?: (conn: GlobalKbConnection) => void,
): Promise<T> {
  const settings = opts.settings ?? (await resolveGlobalKbSettings());
  const conn = await resolveGlobalKbConnection(settings, haiveDb, {
    connectTimeoutSeconds: opts.connectTimeoutSeconds,
    // A pool destroyed at the deadline while that query is pending rejects it with nobody awaiting it.
    ...(opts.deadlineMs === undefined ? {} : { fetchTypes: false }),
  });
  onOpen?.(conn);
  try {
    const key = storeKey(settings);
    // Fresh, not cached: the api may have saved a new width a moment ago in another process. It
    // applies only while the configured store is still the one this call opened.
    const resolveDims = async () => {
      const [mode, connectionString, dims] = await Promise.all([
        configService.getFresh(CONFIG_KEYS.GLOBAL_KB_MODE),
        secretsService.get(SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING),
        configService.getFresh(CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS),
      ]);
      const current = storeKey({
        ...settings,
        mode: mode === 'external' ? 'external' : 'internal',
        connectionString: connectionString || null,
      });
      const raw = Number.parseInt(dims ?? '', 10);
      return current !== key || Number.isNaN(raw) ? settings.embeddingDimensions : raw;
    };
    // A call with a deadline never starts the shared ensure: its deadline kills the pool under it.
    const shared = schemaReady.get(key);
    if (shared) {
      await shared;
    } else if (opts.deadlineMs === undefined) {
      const ready = ensureGlobalKbSchema(conn, { resolveDims }).then(
        (r) => noteIdentifierBackfill(key, r.identifierBackfillDone),
        (err: unknown) => {
          schemaReady.delete(key);
          throw err;
        },
      );
      schemaReady.set(key, ready);
      await ready;
    } else {
      const r = await ensureGlobalKbSchema(conn, { timeoutMs: opts.deadlineMs, resolveDims });
      noteIdentifierBackfill(key, r.identifierBackfillDone);
      if (!schemaReady.has(key)) schemaReady.set(key, Promise.resolve());
    }
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

/** Retries the identifier backfill of the CURRENT store when this process's ensure of it failed or
 *  stopped early; a converged store is not touched, since its count is a scan the index cannot serve. */
export async function retryOwedGlobalIdentifierBackfill(haiveDb: Database): Promise<void> {
  const settings = await resolveGlobalKbSettings();
  const key = storeKey(settings);
  if (!identifierBackfillOwed.has(key)) return;
  await withGlobalKb(
    haiveDb,
    async ({ conn }) => {
      noteIdentifierBackfill(key, await backfillGlobalIdentifierTsv((run) => conn.pg.begin(run)));
    },
    { settings },
  );
}
