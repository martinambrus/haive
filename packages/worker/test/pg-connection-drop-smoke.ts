/**
 * A Postgres backend that dies under a query, against a live database: the caller is rejected,
 * the process survives it, and a short-lived store connection still closes. Nothing is written.
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@haive/database';
import { logger } from '@haive/shared';
import { resolveRagConnection, type RagToolingPrefs } from '@haive/shared/rag';
import { resolveGlobalKbConnection, type GlobalKbSettings } from '@haive/shared/global-kb';

const log = logger.child({ module: 'pg-connection-drop-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}
const url = process.env.DATABASE_URL;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

// Recorded rather than fatal, so a regression fails a check instead of ending the run unreported.
const uncaught: string[] = [];
process.on('uncaughtException', (err) => uncaught.push(String(err)));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = postgres(url, { max: 1 });

/** Terminates the backend running the query tagged with `marker`, once it has started. */
async function dropBackend(marker: string): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const rows = await admin<{ pid: number }[]>`
      select pid from pg_stat_activity
      where query like ${`%${marker}%`} and pid <> pg_backend_pid()
    `;
    if (rows.length > 0) {
      for (const { pid } of rows) await admin`select pg_terminate_backend(${pid})`;
      return rows.length;
    }
    await sleep(50);
  }
  return 0;
}

const sleeper = (marker: string) => `select pg_sleep(5) /* ${marker} */`;

async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const errorCode = (err: unknown): string =>
  (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));

async function main(): Promise<void> {
  const db = createDatabase(url);
  try {
    const marker = 'haive_drop_smoke_tx';
    const [outcome, dropped] = await Promise.all([
      db
        .transaction(async (tx) => {
          await tx.execute(sql.raw(sleeper(marker)));
        })
        .then(() => 'committed', errorCode),
      dropBackend(marker),
    ]);
    await sleep(500);
    check('the backend under a transaction was dropped', dropped === 1, dropped);
    check(
      'the transaction is rejected as a closed connection',
      outcome === 'CONNECTION_CLOSED',
      outcome,
    );
    check('the drop kills nothing', uncaught.length === 0, uncaught);
    const [row] = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    check('the pool answers its next query', row?.ok === 1, row);

    const rag = await resolveRagConnection(
      { ragMode: 'external', ragConnectionString: url, embeddingDimensions: 8 } as RagToolingPrefs,
      db,
      'drop-smoke',
    );
    const ragMarker = 'haive_drop_smoke_rag';
    await Promise.all([rag!.pg.unsafe(sleeper(ragMarker)).catch(() => {}), dropBackend(ragMarker)]);
    check(
      'a RAG store connection closes after its backend dies',
      await settles(rag!.close(), 10_000),
    );

    const kb = await resolveGlobalKbConnection(
      { mode: 'external', connectionString: url, namespace: 'drop-smoke' } as GlobalKbSettings,
      db,
    );
    const kbMarker = 'haive_drop_smoke_kb';
    await Promise.all([kb.pg.unsafe(sleeper(kbMarker)).catch(() => {}), dropBackend(kbMarker)]);
    check(
      'a global KB connection closes after its backend dies',
      await settles(kb.close(), 10_000),
    );
    check('nothing escaped as an uncaught exception', uncaught.length === 0, uncaught);
  } finally {
    await db.$client.end({ timeout: 5 });
    await admin.end({ timeout: 5 });
  }
}

main()
  .then(() => {
    log.info({ checks, failures }, failures === 0 ? 'pg connection drop smoke passed' : 'FAILED');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'pg connection drop smoke crashed');
    process.exit(1);
  });
