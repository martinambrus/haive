import postgres, { type Sql, type TransactionSql } from 'postgres';
import { emit } from './log.js';

/** Databases this repo creates on the same server for other purposes. Pointing the schema runner
 *  at one of them would find none of the expected tables, classify it `fresh`, and build the core
 *  schema inside a vector store. The table quorum cannot catch this — an empty-of-our-tables
 *  database is exactly what `fresh` means — so it is refused by name instead. Three lines against
 *  the one realistic way a misdirected `DATABASE_URL` does damage. */
const NOT_A_TARGET = [/^haive_rag_/, /^haive_kb_global$/];

export class WrongDatabaseError extends Error {}

/**
 * A connection dedicated to migrating.
 *
 * Not `createDatabase()`: that builds a `max: 10` pool with the whole Drizzle schema attached,
 * and the runner needs neither. It needs exactly one connection, because the advisory lock it
 * takes is SESSION-scoped and therefore lives on one specific backend.
 *
 * `max_lifetime: 0` is mandatory, not tidy. postgres.js defaults it to
 * `60 * (30 + Math.random() * 30)` seconds — 30 to 60 minutes — after which it closes and
 * transparently reopens the connection. A session advisory lock dies with its backend, so a long
 * run crossing that boundary would silently lose its lock and keep going.
 */
export function openMigrationClient(url: string): Sql {
  return postgres(url, {
    max: 1,
    max_lifetime: 0,
    connect_timeout: 15,
    connection: { application_name: 'haive-migrate' },
    onnotice: (notice) => emit('pg-notice', { message: notice.message }),
  });
}

export interface TargetIdentity {
  database: string;
  user: string;
  serverVersion: string;
}

/**
 * Report — and sanity-check — what we are actually connected to, before anything is changed.
 *
 * Logged rather than merely checked because "it migrated the wrong database" is otherwise
 * invisible after the fact.
 */
export async function describeTarget(sql: Sql): Promise<TargetIdentity> {
  const [row] = await sql<{ database: string; user: string; version: string }[]>`
    SELECT current_database() AS database, current_user AS user, version() AS version`;
  const identity: TargetIdentity = {
    database: row?.database ?? 'unknown',
    user: row?.user ?? 'unknown',
    serverVersion: (row?.version ?? '').split(' on ')[0] ?? '',
  };
  if (NOT_A_TARGET.some((pattern) => pattern.test(identity.database))) {
    throw new WrongDatabaseError(
      `refusing to migrate "${identity.database}": that is a RAG or global-KB store, not the ` +
        `core Haive database. Check DATABASE_URL.`,
    );
  }
  return identity;
}

/** Block until the server answers, retrying only transient startup failures.
 *
 *  `db-migrate` waits for compose's `service_healthy`, which `pg_isready` can report a moment
 *  before the server actually accepts connections. */
export async function waitForPing(sql: Sql, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      const waitedMs = Math.min(2000, 250 * 2 ** Math.min(attempt - 1, 3));
      emit('lock-wait', { reason: 'database not ready', waitedMs });
      await new Promise((resolve) => setTimeout(resolve, waitedMs));
    }
  }
}

/**
 * Run a multi-statement SQL script on the simple query protocol.
 *
 * The whole file goes in ONE call and is never split on semicolons. A splitter would corrupt the
 * corpus: `pre-baseline/0005` carries a 108-line dollar-quoted literal containing semicolons, a
 * `--stat` sequence and a bare `---`, and ten other files carry `DO $$ … $$;` blocks with
 * internal semicolons. The simple protocol accepts multiple statements in one message, which is
 * what makes splitting unnecessary.
 *
 * The cast is required, not sloppy: postgres.js READS `options.simple` at runtime
 * (`src/index.js:118-126`) but its `UnsafeQueryOptions` type declares only `prepare`. Passing it
 * explicitly rather than relying on the `args.length === 0` default keeps the intent visible and
 * survives a change to that default.
 */
export async function runSqlScript(sql: Sql | TransactionSql, text: string): Promise<void> {
  await sql.unsafe(text, [], { simple: true } as Parameters<Sql['unsafe']>[2]);
}
