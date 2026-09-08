#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { baselineColumns, baselineTableNames } from './baseline.js';
import { classifyDatabase, columnDrift } from './adoption.js';
import { checksum } from './checksum.js';
import {
  describeTarget,
  openMigrationClient,
  runSqlScript,
  waitForPing,
  WrongDatabaseError,
} from './client.js';
import { parseDirectives } from './directives.js';
import {
  assertNoDuplicatePrefix,
  listMigrationFiles,
  MigrationDiscoveryError,
} from './discover.js';
import { ensureJournal, journalColumns, readApplied, recordApplied } from './journal.js';
import {
  acquireMigrationLock,
  assertLockHeld,
  LockLostError,
  LockNotAcquiredError,
} from './lock.js';
import { emit } from './log.js';
import { BASELINE_FILENAME, migrationsDir } from './paths.js';
import { localMigrations, planPending, type LocalMigration } from './plan.js';
import { isActiveSqlTransaction } from '../pg-errors.js';

/** Exit codes, so compose, CI and the updater can branch on the OUTCOME rather than parse text. */
const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  indeterminate: 3,
  checksum: 4,
  lockBusy: 5,
  lockLost: 6,
  fork: 7,
} as const;

class FatalError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const LOCK_TIMEOUT_MS = Number(process.env.HAIVE_MIGRATE_LOCK_TIMEOUT_MS ?? 120_000);
/** Bounds how long a migration will wait for a lock on a busy table before failing. Without it,
 *  DDL needing ACCESS EXCLUSIVE queues in front of every other reader and freezes the app; with
 *  it, "the migration is slow" becomes "the migration failed and the app kept serving".
 *  `statement_timeout` is deliberately NOT set — a legitimate backfill can exceed any value, and
 *  a backfill killed mid-transaction is simply no backfill. */
const STATEMENT_LOCK_TIMEOUT_MS = Number(process.env.HAIVE_MIGRATE_STMT_LOCK_TIMEOUT_MS ?? 15_000);

interface LoadedMigration extends LocalMigration {
  text: string;
}

function loadCorpus(): { dir: string; baseline: LoadedMigration; rest: LoadedMigration[] } {
  const dir = migrationsDir();
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new FatalError(`migrations directory not found or unreadable: ${dir}`, EXIT.usage);
  }

  const files = listMigrationFiles(readdirSync(dir));
  // Never "found 0 migrations, nothing to do": a silent no-op looks like success and leaves an
  // empty database behind, which is the worst failure available here.
  if (!files.includes(BASELINE_FILENAME)) {
    throw new FatalError(
      `${BASELINE_FILENAME} is missing from ${dir}. Without the baseline a fresh database ` +
        `cannot be built, and the pre-baseline corpus cannot substitute for it.`,
      EXIT.usage,
    );
  }
  assertNoDuplicatePrefix(files);

  const loaded = files.map((filename) => {
    const text = readFileSync(join(dir, filename), 'utf8');
    const [entry] = localMigrations([{ filename, checksum: checksum(text) }]);
    return { ...entry!, text };
  });
  const baseline = loaded.find((m) => m.filename === BASELINE_FILENAME)!;
  return { dir, baseline, rest: loaded.filter((m) => m.filename !== BASELINE_FILENAME) };
}

async function presentTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  return rows.map((r) => r.table_name);
}

async function presentColumns(sql: Sql): Promise<Set<string>> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`;
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

/** Apply one file and journal it, atomically wherever the file allows it. */
async function applyMigration(
  sql: Sql,
  migration: LoadedMigration,
  appliedBy: 'baseline-fresh' | 'runner',
): Promise<void> {
  const started = Date.now();
  const { noTransaction } = parseDirectives(migration.text);

  if (noTransaction) {
    // Outside a transaction, so the file and its journal row are two steps. The window between
    // them is unavoidable and is exactly why this escape hatch must stay rare.
    await runSqlScript(sql, migration.text);
    await recordApplied(sql, {
      id: migration.id,
      checksum: migration.checksum,
      durationMs: Date.now() - started,
      appliedBy,
    });
    return;
  }

  try {
    await sql.begin(async (tx) => {
      // `tx` is a scoped Sql bound to the transaction's own connection — using the outer `sql`
      // here would escape the transaction entirely.
      await runSqlScript(tx, `SET LOCAL lock_timeout = '${STATEMENT_LOCK_TIMEOUT_MS}ms'`);
      await runSqlScript(tx, migration.text);
      await recordApplied(tx, {
        id: migration.id,
        checksum: migration.checksum,
        durationMs: Date.now() - started,
        appliedBy,
      });
    });
  } catch (err) {
    // 25001 active_sql_transaction — e.g. "CREATE INDEX CONCURRENTLY cannot run inside a
    // transaction block". Turn an opaque Postgres error into the fix.
    if (isActiveSqlTransaction(err)) {
      throw new FatalError(
        `${migration.filename} cannot run inside a transaction. Add "-- haive:no-transaction" ` +
          `to its header (within the first 20 lines) if that is intended. Postgres said: ` +
          `${(err as Error).message}`,
        EXIT.unexpected,
      );
    }
    throw err;
  }
}

async function main(): Promise<number> {
  const statusOnly = process.argv.includes('--status');
  const url = process.env.DATABASE_URL;
  if (!url) throw new FatalError('DATABASE_URL is required', EXIT.usage);

  const { dir, baseline, rest } = loadCorpus();
  const sql = openMigrationClient(url);
  try {
    await waitForPing(sql);
    const target = await describeTarget(sql);
    emit('target', { ...target, migrationsDir: dir, files: rest.length + 1 });

    const lockPid = await acquireMigrationLock(sql, LOCK_TIMEOUT_MS);

    // Classification happens BEFORE the journal table is created. Creating it first would make
    // every database look managed and destroy the classifier outright.
    const expectedTables = baselineTableNames(baseline.text);
    const existingJournalColumns = await journalColumns(sql);
    const classification = classifyDatabase({
      expectedTables,
      presentTables: await presentTables(sql),
      journalColumns: existingJournalColumns,
      journalRowCount:
        existingJournalColumns === null
          ? 0
          : Number(
              (await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM schema_migrations`)[0]
                ?.n ?? 0,
            ),
    });
    emit('classified', { kind: classification.kind });

    if (classification.kind === 'foreign-journal') {
      throw new FatalError(
        `this database has a "schema_migrations" table that is not ours (missing columns: ` +
          `${classification.missingJournalColumns.join(', ')}). Refusing to touch it.`,
        EXIT.unexpected,
      );
    }
    if (classification.kind === 'indeterminate') {
      const shown = classification.missingTables.slice(0, 15);
      throw new FatalError(
        `this database has SOME of the expected schema but not all of it — ${classification.missingTables.length} ` +
          `of ${expectedTables.length} tables are missing, which is what an interrupted ` +
          `"drizzle-kit push" leaves behind. Refusing to adopt or rebuild it. Missing: ` +
          `${shown.join(', ')}${classification.missingTables.length > shown.length ? ', …' : ''}`,
        EXIT.indeterminate,
      );
    }

    if (classification.kind === 'legacy') {
      const drift = columnDrift(baselineColumns(baseline.text), await presentColumns(sql));
      if (drift.missing.length > 0) {
        const shown = drift.missing.slice(0, 15);
        throw new FatalError(
          `this database has every expected table but is missing ${drift.missing.length} column(s), ` +
            `so it was last synced from an older schema. Run "pnpm db:push" once to bring it to ` +
            `the baseline, then run migrate again. Missing: ${shown.join(', ')}` +
            `${drift.missing.length > shown.length ? ', …' : ''}`,
          EXIT.indeterminate,
        );
      }
    }

    await ensureJournal(sql);

    if (classification.kind === 'legacy') {
      const started = Date.now();
      await recordApplied(sql, {
        id: baseline.id,
        checksum: baseline.checksum,
        durationMs: Date.now() - started,
        appliedBy: 'baseline-adopt',
      });
      emit('adopted', {
        id: baseline.id,
        note: 'stamped without executing; schema already present',
      });
    }

    // The baseline is ALWAYS part of the plan, never only on the fresh path. planPending decides
    // what to APPLY from what is already journalled, so on a fresh database the baseline is
    // pending and on every other one it is already recorded — but excluding it here would leave
    // its checksum unaudited on every managed database and then report it as an unknown "ahead"
    // row, which is the opposite of the truth. MEASURED: a corrupted baseline checksum exited 0.
    const applied = await readApplied(sql);
    if (classification.kind !== 'fresh' && !applied.some((row) => row.id === baseline.id)) {
      throw new FatalError(
        `this database has a migration journal but no row for ${baseline.id}. That cannot happen ` +
          `from a normal run, so the journal has been edited or truncated. Refusing rather than ` +
          `re-applying the baseline over a populated schema.`,
        EXIT.fork,
      );
    }
    const plan = planPending([baseline, ...rest], applied);

    if (plan.mismatched.length > 0) {
      const lines = plan.mismatched.map(
        (m) =>
          `  ${m.id}\n    recorded ${m.recorded}\n    on disk  ${m.actual}\n` +
          `    if the edit was intentional: UPDATE schema_migrations SET checksum = '${m.actual}' WHERE id = '${m.id}';`,
      );
      throw new FatalError(
        `applied migrations have changed on disk. Nothing was applied.\n${lines.join('\n')}`,
        EXIT.checksum,
      );
    }

    if (plan.unknown.length > 0) {
      if (plan.toApply.length > 0) {
        throw new FatalError(
          `this database has migrations this code does not (${plan.unknown.join(', ')}) AND this ` +
            `code has migrations it has never seen (${plan.toApply.map((m) => m.id).join(', ')}). ` +
            `That is a fork, not an upgrade. Refusing.`,
          EXIT.fork,
        );
      }
      // Ahead but coherent — exactly what a rollback to older images looks like. Not an error.
      emit('ahead', { ids: plan.unknown });
    }

    if (statusOnly) {
      emit('done', {
        status: true,
        pending: plan.toApply.map((m) => m.id),
        applied: plan.unknown.length,
      });
      return EXIT.ok;
    }

    for (const migration of plan.toApply) {
      await assertLockHeld(sql, lockPid);
      emit('applying', { id: migration.id });
      const started = Date.now();
      await applyMigration(
        sql,
        migration as LoadedMigration,
        migration.id === baseline.id ? 'baseline-fresh' : 'runner',
      );
      emit('applied', { id: migration.id, ms: Date.now() - started });
    }

    emit('done', { applied: plan.toApply.length, kind: classification.kind });
    return EXIT.ok;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof FatalError) {
    emit('error', { message: err.message });
    process.exit(err.code);
  }
  if (err instanceof LockNotAcquiredError) {
    emit('error', { message: err.message });
    process.exit(EXIT.lockBusy);
  }
  if (err instanceof LockLostError) {
    emit('error', { message: err.message });
    process.exit(EXIT.lockLost);
  }
  if (err instanceof MigrationDiscoveryError || err instanceof WrongDatabaseError) {
    emit('error', { message: err.message });
    process.exit(EXIT.usage);
  }
  emit('error', { message: err instanceof Error ? err.message : String(err) });
  process.exit(EXIT.unexpected);
}
