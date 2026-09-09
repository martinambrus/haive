/**
 * Integration smoke for the migration runner against a real Postgres.
 *
 * The unit tests cover every pure predicate — classification, planning, discovery, directives,
 * checksums — in isolation. What they cannot cover is the part that only exists in a database:
 * whether the baseline actually builds a schema, whether adoption stamps WITHOUT executing DDL,
 * whether a partial schema is refused rather than adopted, and whether two runners racing on one
 * empty database produce exactly one set of journal rows.
 *
 * Runs the built CLI as a subprocess rather than importing it, because the exit code IS the
 * contract that compose, CI and the updater branch on. Each case gets its own throwaway database
 * so a failure cannot leak into the next one.
 *
 * Lives in @haive/database rather than the worker: the code under test is here, and the worker's
 * smoke suite has no business depending on this package's internals.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

const adminUrl = process.env.DATABASE_URL;
const RUNNER = fileURLToPath(new URL('../dist/migrate/index.js', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

/** How many files the corpus holds RIGHT NOW.
 *
 *  Read rather than written down: every assertion below that used to name a literal 1 was true
 *  only while the directory held the baseline alone, and the first real migration turned three of
 *  them red for being right. The invariants are "one runner did the applying" and "one journal row
 *  per file" — neither is a number this file gets to know. */
async function corpusSize(): Promise<number> {
  return (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).length;
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`[smoke] ok   ${label}`);
  } else {
    console.error(
      `[smoke] FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`,
    );
    failures.push(label);
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runMigrate(
  dbUrl: string,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [RUNNER, ...args], {
      env: { ...process.env, DATABASE_URL: dbUrl, ...extraEnv },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function urlFor(dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

// `DROP DATABASE IF EXISTS` on a database that is not there is a NOTICE, not news.
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const created: string[] = [];

async function freshDatabase(suffix: string): Promise<string> {
  const name = `haive_migrate_smoke_${suffix}_${process.pid}`;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  created.push(name);
  return name;
}

async function withDb<T>(dbName: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(urlFor(dbName), { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  // 1. FRESH — the baseline builds the whole schema and journals itself.
  {
    const db = await freshDatabase('fresh');
    const run = await runMigrate(urlFor(db));
    check('fresh: exits 0', run.code === 0, run.stderr);
    check('fresh: classified fresh', run.stdout.includes('"kind":"fresh"'));
    await withDb(db, async (sql) => {
      const [tables] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      // Every core table the pre-baseline corpus could never create.
      const [core] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('users','tasks','repositories','cli_providers','task_steps','cli_invocations')`;
      check('fresh: core tables exist', core?.n === '6', core);
      check('fresh: schema is populated', Number(tables?.n ?? 0) > 50, tables);
      const rows = await sql<{ id: string; applied_by: string }[]>`
        SELECT id, applied_by FROM schema_migrations ORDER BY id`;
      check(
        'fresh: baseline journalled as baseline-fresh',
        rows[0]?.applied_by === 'baseline-fresh',
        rows,
      );
    });

    // 2. IDEMPOTENT — a second run applies nothing.
    const again = await runMigrate(urlFor(db));
    check('idempotent: exits 0', again.code === 0, again.stderr);
    check('idempotent: classified managed', again.stdout.includes('"kind":"managed"'));
    check('idempotent: applied nothing', again.stdout.includes('"applied":0'));

    // 5. CHECKSUM MISMATCH — a recorded checksum that no longer matches is fatal, and nothing runs.
    await withDb(db, async (sql) => {
      await sql`UPDATE schema_migrations SET checksum = 'tampered' WHERE id = '0000_baseline'`;
    });
    const tampered = await runMigrate(urlFor(db));
    check('checksum: exits 4', tampered.code === 4, { code: tampered.code });
    check(
      'checksum: prints the recovery SQL',
      tampered.stderr.includes('UPDATE schema_migrations SET checksum'),
    );
  }

  // 3. ADOPT — a database the old push applier built is stamped, never rebuilt.
  {
    const db = await freshDatabase('legacy');
    await execFileAsync('pnpm', ['--filter', '@haive/database', 'push', '--force'], {
      env: { ...process.env, DATABASE_URL: urlFor(db) },
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      maxBuffer: 16 * 1024 * 1024,
    });
    // A sentinel row proves no baseline DDL ran: a CREATE TABLE would have failed, and a
    // DROP/CREATE would have taken this row with it.
    await withDb(db, async (sql) => {
      await sql`INSERT INTO users (email_encrypted, email_blind_index, password_hash)
                VALUES ('sentinel', 'sentinel-idx', 'x')`;
    });
    const run = await runMigrate(urlFor(db));
    check('adopt: exits 0', run.code === 0, run.stderr);
    check('adopt: classified legacy', run.stdout.includes('"kind":"legacy"'));
    await withDb(db, async (sql) => {
      const rows = await sql<
        { id: string; applied_by: string }[]
      >`SELECT id, applied_by FROM schema_migrations ORDER BY id`;
      // The BASELINE is what must be stamped rather than executed — a database push built already
      // has its tables. Post-baseline migrations then run normally and are `runner` rows; that is
      // the correct outcome and the reason every one of them is written guarded and idempotent.
      const adopted = rows.filter((r) => r.applied_by === 'baseline-adopt');
      check(
        'adopt: exactly one baseline-adopt row',
        adopted.length === 1 && adopted[0]?.id === '0000_baseline',
        rows,
      );
      check(
        'adopt: every later migration ran as the runner',
        rows.every((r) => r.id === '0000_baseline' || r.applied_by === 'runner'),
        rows,
      );
      check('adopt: journal holds one row per file', rows.length === (await corpusSize()), rows);
      const sentinel = await sql<{ email_encrypted: string }[]>`SELECT email_encrypted FROM users`;
      check(
        'adopt: sentinel row survived, so no DDL ran',
        sentinel[0]?.email_encrypted === 'sentinel',
        sentinel,
      );
    });
  }

  // 4. INDETERMINATE — a partial schema is refused, not adopted and not rebuilt. This is what an
  //    interrupted `push --force` leaves behind, and adopting it would hide the damage for months.
  {
    const db = await freshDatabase('partial');
    await withDb(db, async (sql) => {
      await sql.unsafe('CREATE TABLE users (id uuid PRIMARY KEY)');
      await sql.unsafe('CREATE TABLE tasks (id uuid PRIMARY KEY)');
    });
    const run = await runMigrate(urlFor(db));
    check('indeterminate: exits 3', run.code === 3, { code: run.code });
    check('indeterminate: names missing tables', run.stderr.includes('tables are missing'));
    await withDb(db, async (sql) => {
      const [journal] = await sql<
        { reg: string | null }[]
      >`SELECT to_regclass('public.schema_migrations')::text AS reg`;
      check('indeterminate: created nothing', journal?.reg === null, journal);
    });
  }

  // 6. FOREIGN JOURNAL — someone else's schema_migrations is a hard stop, never a migration target.
  {
    const db = await freshDatabase('foreign');
    await withDb(db, async (sql) => {
      await sql.unsafe('CREATE TABLE schema_migrations (version varchar PRIMARY KEY)');
      await sql.unsafe("INSERT INTO schema_migrations VALUES ('20240101000000')");
    });
    const run = await runMigrate(urlFor(db));
    check('foreign journal: refuses', run.code !== 0, { code: run.code });
    check('foreign journal: says why', run.stderr.includes('not ours'));
  }

  // 7. CONCURRENCY — two runners on one empty database produce exactly one set of journal rows.
  {
    const db = await freshDatabase('race');
    const [a, b] = await Promise.all([runMigrate(urlFor(db)), runMigrate(urlFor(db))]);
    check('race: both exit 0', a.code === 0 && b.code === 0, { a: a.code, b: b.code });
    const size = await corpusSize();
    // One runner does the whole corpus and the other finds nothing to do — the lock is what makes
    // it all-or-nothing rather than a split.
    const applied = [a, b].filter((r) => r.stdout.includes(`"applied":${size}`)).length;
    const idle = [a, b].filter((r) => r.stdout.includes('"applied":0')).length;
    check('race: exactly one runner applied the corpus', applied === 1 && idle === 1, {
      applied,
      idle,
      size,
    });
    await withDb(db, async (sql) => {
      const rows = await sql<{ id: string }[]>`SELECT id FROM schema_migrations`;
      check('race: one journal row per file, no duplicates', rows.length === size, rows);
    });
  }

  // 8. NO-TRANSACTION GUARD — a statement that cannot run in a transaction fails with the fix
  //    named, and succeeds once the file declares the directive.
  {
    const db = await freshDatabase('concurrent_index');
    await runMigrate(urlFor(db));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-migrate-'));
    try {
      // The WHOLE corpus, not the baseline alone: the database above was migrated with every
      // file, so a directory holding fewer is a FORK to the runner, which refuses before it ever
      // reaches the directive this case is about. Numbered above anything real for the same
      // reason — a fixture that collides with a shipped id is the same refusal by another name.
      for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql'))) {
        await execFileAsync('cp', [path.join(MIGRATIONS, file), dir]);
      }
      const target = path.join(dir, '9999_concurrent_index.sql');
      const body =
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS smoke_idx ON users (email_blind_index);\n';

      await writeFile(target, body, 'utf8');
      const without = await runMigrate(urlFor(db), { HAIVE_MIGRATIONS_DIR: `${dir}/` });
      check('no-transaction: fails without the directive', without.code !== 0, {
        code: without.code,
      });
      check(
        'no-transaction: names the fix',
        without.stderr.includes('haive:no-transaction'),
        without.stderr.slice(0, 200),
      );

      await writeFile(target, `-- haive:no-transaction\n${body}`, 'utf8');
      const withDirective = await runMigrate(urlFor(db), { HAIVE_MIGRATIONS_DIR: `${dir}/` });
      check(
        'no-transaction: succeeds with the directive',
        withDirective.code === 0,
        withDirective.stderr,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // 9. MISSING CORPUS — never a silent no-op. "Found 0 migrations, nothing to do" looks like
  //    success and leaves an empty database behind.
  {
    const db = await freshDatabase('nodir');
    const run = await runMigrate(urlFor(db), {
      HAIVE_MIGRATIONS_DIR: '/nonexistent-haive-migrations/',
    });
    check('missing corpus: exits 2', run.code === 2, { code: run.code });
  }

  // 10. WRONG DATABASE — this repo creates RAG and global-KB stores on the same server, and the
  //     table quorum cannot catch a misdirected URL because "none of our tables" is what fresh
  //     means. Refused by name instead.
  {
    const name = 'haive_kb_global';
    const run = await runMigrate(urlFor(name));
    check('wrong database: refuses a global-KB store by name', run.code === 2, { code: run.code });
  }
}

try {
  await main();
} catch (err) {
  console.error('[smoke] threw', err);
  failures.push('unexpected exception');
} finally {
  for (const name of created) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 });
}

if (failures.length > 0) {
  console.error(`[smoke] ${failures.length} FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('[smoke] migrate: all checks passed');
