import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baselineColumns, baselineTableNames } from './baseline.js';
import { checksum } from './checksum.js';

const baselineUrl = new URL('../../migrations/0000_baseline.sql', import.meta.url);
const baselineSql = readFileSync(fileURLToPath(baselineUrl), 'utf8');

const SAMPLE = `CREATE TYPE "public"."thing" AS ENUM('a', 'b');
CREATE TABLE "widgets" (
\t"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
\t"name" text NOT NULL,
\tCONSTRAINT "widgets_name_positive" CHECK ("widgets"."name" <> '')
);

CREATE TABLE "gadgets" (
\t"id" uuid PRIMARY KEY
);
`;

describe('baselineTableNames', () => {
  it('finds every created table', () => {
    expect(baselineTableNames(SAMPLE)).toEqual(['widgets', 'gadgets']);
  });
});

describe('baselineColumns', () => {
  it('finds columns and excludes constraint lines', () => {
    expect([...baselineColumns(SAMPLE)].sort()).toEqual([
      'gadgets.id',
      'widgets.id',
      'widgets.name',
    ]);
  });
});

describe('the real baseline', () => {
  // The standing guard that a re-cut baseline is COMPLETE. drizzle-kit's export swallows its own
  // errors and still exits 0, so a truncated baseline is a real possibility; this asserts the
  // applied schema against the barrel it is supposed to represent.
  //
  // Against the baseline PLUS every later migration, not the baseline alone. The baseline is
  // FROZEN, so it legitimately falls behind the barrel the moment a migration adds a table —
  // asserting equality with it by itself turns the first such migration red and stays red, which
  // is a guard failing for being right. A truncated baseline is still caught: the union would
  // then be SHORT of the barrel.
  it('the migrations create exactly as many tables as the barrel declares', () => {
    const schemaDir = new URL('../schema/', import.meta.url);
    let declared = 0;
    for (const file of readdirSync(schemaDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(new URL(file, schemaDir), 'utf8');
      declared += (src.match(/=\s*pgTable\(/g) ?? []).length;
    }
    const tables = new Set(baselineTableNames(baselineSql));
    // A LOOSER parser than the production one, deliberately: `baselineTableNames` matches
    // drizzle-kit's exact generated shape, while these are hand-written and guarded
    // (`CREATE TABLE IF NOT EXISTS`). Tightening the production parser to fit them would make it
    // accept output drizzle-kit never produces, which is the shape it exists to verify.
    const migrationsDir = new URL('../../migrations/', import.meta.url);
    for (const file of readdirSync(migrationsDir).sort()) {
      if (!file.endsWith('.sql') || file === '0000_baseline.sql') continue;
      // Comments STRIPPED first. Every migration here documents its own rollback, which means the
      // header literally contains `DROP TABLE IF EXISTS "…"` — matched by the loop below, this
      // silently removed the very table the file creates and the count came out unchanged.
      const sql = readFileSync(new URL(file, migrationsDir), 'utf8').replace(/--[^\n]*/g, '');
      for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([a-z0-9_]+)"?/gi)) {
        tables.add(m[1]!);
      }
      for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?"?([a-z0-9_]+)"?/gi)) {
        tables.delete(m[1]!);
      }
    }

    expect(tables.size).toBe(declared);
  });

  it('creates the core tables the pre-baseline corpus never could', () => {
    const tables = new Set(baselineTableNames(baselineSql));
    for (const core of [
      'users',
      'tasks',
      'repositories',
      'cli_providers',
      'task_steps',
      'cli_invocations',
    ]) {
      expect(tables).toContain(core);
    }
  });

  // The pin. Its only job is to stop a future change regenerating the baseline in passing: doing
  // so breaks every install that has already recorded this checksum, and a red test with this
  // comment is the warning. Re-cutting the schema deliberately means shipping a LATER numbered
  // baseline, not editing this one — see the file's own header.
  it('has not changed', () => {
    expect(checksum(baselineSql)).toBe(
      '3359268e8cdbbc4e6c5b2d5f34a5bbbeda2ee8005af7f3971c6f3e7f58c85057',
    );
  });
});
