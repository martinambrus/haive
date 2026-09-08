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
  // committed file against the schema barrel it is supposed to represent.
  it('creates exactly as many tables as the barrel declares', () => {
    const schemaDir = new URL('../schema/', import.meta.url);
    let declared = 0;
    for (const file of readdirSync(schemaDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(new URL(file, schemaDir), 'utf8');
      declared += (src.match(/=\s*pgTable\(/g) ?? []).length;
    }
    expect(baselineTableNames(baselineSql).length).toBe(declared);
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
