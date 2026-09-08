#!/usr/bin/env node
// Generate migrations/0000_baseline.sql — the genesis the migration runner applies to a
// fresh database.
//
// Why this exists at all: the pre-baseline corpus has no genesis migration. Nothing in it
// creates users, tasks, repositories, cli_providers, task_steps or cli_invocations, so those
// 152 files cannot build a database and never could. The baseline is what replaces them.
//
// Producer is `drizzle-kit export --sql`, which is `preparePgMigrationSnapshot([], schema)` —
// literally "no snapshots before" — fed to applyPgSnapshotsDiff. `preparePgPush` sits directly
// below it in the same bundle calling the SAME differ, its `prev` coming from live
// introspection instead. Against an empty database the two are the same generator on the same
// empty prior state, which is why the baseline and `push --force` agree by construction rather
// than by coincidence. Neither `drizzle-kit generate` (writes a meta/_journal.json into the
// corpus and takes over numbering) nor `pg_dump` (launders the DDL through the catalog into
// pg_dump's idiom, and needs a live stack) can make that claim.
//
// MEASURED, and the reason every check below exists: `prepareAndExportPg`'s body ends
// `console.log(sqlStatements.join("\n")); } catch (e) { console.error(e); }`. It does not
// rethrow and does not set an exit code, so a failed export prints a stack to stderr and exits
// 0 with EMPTY STDOUT. A plain `drizzle-kit export --sql > 0000_baseline.sql` therefore writes
// a zero-byte baseline and reports success. The count check against the schema barrel is what
// catches a truncated or empty export; nothing upstream will.

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaDir = new URL('../src/schema/', import.meta.url);
const outPath = fileURLToPath(new URL('../migrations/0000_baseline.sql', import.meta.url));

function die(message) {
  console.error(`[baseline] ${message}`);
  process.exit(1);
}

/** Declaration-form counts from the barrel. `= pgTable(` rather than `pgTable(` so an import,
 *  a re-export or a mention in prose cannot inflate the expected number. */
function barrelCounts() {
  let tables = 0;
  let enums = 0;
  for (const file of readdirSync(schemaDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = readFileSync(new URL(file, schemaDir), 'utf8');
    tables += (src.match(/=\s*pgTable\(/g) ?? []).length;
    enums += (src.match(/=\s*pgEnum\(/g) ?? []).length;
  }
  return { tables, enums };
}

const header = `-- GENERATED FILE — DO NOT EDIT BY HAND.
--
-- Regenerate with: pnpm --filter @haive/database baseline:generate --force
--
-- The genesis migration. This is the ONLY file permitted to create the whole schema, and it is
-- what the runner applies to a fresh database. Everything in migrations/pre-baseline/ predates
-- it and is never executed — see that directory's README for why replaying it is unsafe.
--
-- FROZEN once committed. Its sha256 is recorded in schema_migrations on every install that has
-- run it, so an edit here — including a comment — hard-fails every one of them with a checksum
-- mismatch. It legitimately falls behind the schema barrel the moment the next numbered
-- migration lands; that is correct and is why the CI schema-parity job proves END-STATE
-- equivalence against \`drizzle-kit push --force\` rather than regenerating and diffing this file.
--
-- Regenerating is a deliberate schema re-cut, never part of a feature. A re-cut must ship as a
-- LATER numbered baseline that adoption stamps rather than runs, or every existing install is
-- asked to re-create tables it already has.
`;

const force = process.argv.includes('--force');
if (existsSync(outPath) && !force) {
  die(
    `${outPath} already exists and the baseline is frozen.\n` +
      `           Regenerating it breaks every install that recorded its checksum.\n` +
      `           Pass --force only if you are deliberately re-cutting the schema.`,
  );
}

let stdout;
let stderr;
try {
  ({ stdout, stderr } = await execFileAsync(
    'npx',
    ['drizzle-kit', 'export', '--sql', '--config', 'drizzle.config.ts'],
    { cwd: pkgRoot, maxBuffer: 64 * 1024 * 1024 },
  ));
} catch (err) {
  die(`drizzle-kit export failed to spawn or exited non-zero: ${err?.message ?? err}`);
}

// drizzle-kit swallows its own export errors and still exits 0, printing the stack here.
if (stderr.trim().length > 0) {
  die(`drizzle-kit export wrote to stderr, which means it FAILED despite exiting 0:\n${stderr}`);
}

const sql = stdout.trim();
if (sql.length === 0) die('drizzle-kit export produced no SQL (the swallowed-error case).');
if (!sql.endsWith(';')) die('export output does not end in ";" — it is truncated.');

const expected = barrelCounts();
const actual = {
  tables: (sql.match(/^CREATE TABLE /gm) ?? []).length,
  enums: (sql.match(/^CREATE TYPE /gm) ?? []).length,
};

// The check that actually catches a truncated export. A partial diff still looks like valid SQL
// and still ends in a semicolon; only the count says it is missing half the schema.
if (actual.tables !== expected.tables || actual.enums !== expected.enums) {
  die(
    `export does not match the schema barrel — refusing to write a partial baseline.\n` +
      `           tables: ${actual.tables} in SQL vs ${expected.tables} pgTable() in src/schema/\n` +
      `           enums:  ${actual.enums} in SQL vs ${expected.enums} pgEnum() in src/schema/`,
  );
}

writeFileSync(outPath, `${header}\n${sql}\n`, 'utf8');
console.log(
  `[baseline] wrote ${outPath} — ${actual.tables} tables, ${actual.enums} enums, ${sql.length} bytes of SQL`,
);
