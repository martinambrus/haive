import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDirectives } from './directives.js';

describe('parseDirectives', () => {
  it('reads the directive from the header', () => {
    expect(
      parseDirectives('-- haive:no-transaction\nCREATE INDEX CONCURRENTLY x;').noTransaction,
    ).toBe(true);
    expect(
      parseDirectives('-- a comment\n\n-- haive:no-transaction\nSELECT 1;').noTransaction,
    ).toBe(true);
    expect(parseDirectives('--haive:no-transaction\nSELECT 1;').noTransaction).toBe(true);
  });

  it('is absent by default', () => {
    expect(
      parseDirectives('-- ordinary migration\nALTER TABLE x ADD COLUMN y int;').noTransaction,
    ).toBe(false);
  });

  // Header-scoped, so a file's BODY cannot flip its own execution mode.
  it('ignores the directive past the header', () => {
    const late = `${'-- filler\n'.repeat(25)}-- haive:no-transaction\nSELECT 1;`;
    expect(parseDirectives(late).noTransaction).toBe(false);
  });

  // The file that would defeat a naive scan, tested against its real bytes: a ~108-line markdown
  // document inside a $rules$ literal, containing semicolons, a `--stat` sequence and a bare
  // `---`. If prose could set a directive, this is the file that would prove it.
  it('finds no directive in the real 0005, whose body is embedded markdown', () => {
    const path = fileURLToPath(
      new URL('../../migrations/pre-baseline/0005_cli_provider_rules_content.sql', import.meta.url),
    );
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('$rules$');
    expect(parseDirectives(text).noTransaction).toBe(false);
  });

  it('finds no directive in the real baseline', () => {
    const path = fileURLToPath(new URL('../../migrations/0000_baseline.sql', import.meta.url));
    expect(parseDirectives(readFileSync(path, 'utf8')).noTransaction).toBe(false);
  });

  // The INVERSE guard, and the one that is easy to forget: a file that DECLARES the directive
  // without needing it loses atomicity forever, silently. Adding one must therefore be a
  // deliberate edit to this list that a reviewer sees, not something a migration author can do
  // alone. Empty today — nothing in the corpus needs to run outside a transaction.
  it('no live migration declares the directive', () => {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const declaring = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) => parseDirectives(readFileSync(`${dir}${name}`, 'utf8')).noTransaction);
    expect(declaring).toEqual([]);
  });
});
