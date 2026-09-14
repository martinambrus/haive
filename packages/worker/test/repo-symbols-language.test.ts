import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRepoSymbols } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

// The citation scrub asks for an anchor repo's symbols with NO language, and the old fallback
// was ['.php','.js','.ts','.py'] — which misses Drupal's own .module/.inc/.theme, the exact
// shape the scrub exists for (the entry that motivated it cited `activit.module:534`).
describe('collectRepoSymbols with an unknown language', () => {
  async function repoWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-'));
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), body, 'utf8');
    }
    return dir;
  }

  it('finds symbols in extensions the four-entry default missed', async () => {
    const dir = await repoWith({
      'activit.module': 'function activit_menu_alter($items) {}',
      'helper.inc': 'function activit_render_icon($name) {}',
      'main.go':
        'func ProcessInvoiceBatch() {}\ntype InvoiceWriter interface {}\nfunc (r *Repo) SaveInvoiceBatch() {}',
      'calc.py': 'def compute_totals(rows):\n    return rows',
      'lib.rb': 'class InvoiceSerializer\nend',
    });
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('activit_menu_alter')).toBe(true);
    expect(symbols.has('activit_render_icon')).toBe(true);
    expect(symbols.has('InvoiceSerializer')).toBe(true);
    // Asserted, not merely present in the fixture: scanning `.go`/`.py` collects nothing
    // unless the DECLARATION keywords are known too, and this file used to contain
    // `func ProcessInvoiceBatch()` while asserting only the keywords PHP already had.
    expect(symbols.has('ProcessInvoiceBatch')).toBe(true);
    expect(symbols.has('InvoiceWriter')).toBe(true);
    expect(symbols.has('compute_totals')).toBe(true);
    expect(symbols.has('SaveInvoiceBatch')).toBe(true);
  });

  it('still scans only the named language when one is given', async () => {
    const dir = await repoWith({
      'activit.module': 'function activit_menu_alter($items) {}',
      'lib.rb': 'class InvoiceSerializer\nend',
    });
    const symbols = await collectRepoSymbols(dir, 'ruby');
    expect(symbols.has('InvoiceSerializer')).toBe(true);
    expect(symbols.has('activit_menu_alter')).toBe(false);
  });
});

// JS/TS declare most helpers with no keyword at all, so a keyword-anchored scan missed exactly
// the forms those repos use most — while bodyUsesRepoSymbol recognises their call syntax in an
// article, letting a copied repo-private helper through the scrub.
describe('collectRepoSymbols on keyword-less JS/TS declarations', () => {
  it('collects assigned functions and class methods', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-js-'));
    await writeFile(
      path.join(dir, 'invoice.ts'),
      [
        'const calculateInvoiceTotal = (rows: Row[]) => rows.length;',
        'export const serializeInvoice = async (x: Row) => x;',
        'class InvoiceRepo {',
        '  async loadInvoices(id: string) {',
        '    return id;',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'typescript');
    expect(symbols.has('calculateInvoiceTotal')).toBe(true);
    expect(symbols.has('serializeInvoice')).toBe(true);
    expect(symbols.has('loadInvoices')).toBe(true);
  });

  it('covers the declaration keywords of every language it claims to scan', async () => {
    // The extension map claims php/js/ts/python/ruby/go, so the keyword set has to match it:
    // `enum` is PHP 8.1 and TypeScript, `module` is Ruby. A claimed extension whose keyword is
    // unknown scans the file and collects nothing, which is how this was wrong twice before.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-kw2-'));
    await writeFile(path.join(dir, 'status.php'), '<?php enum InvoiceStatus { }', 'utf8');
    await writeFile(path.join(dir, 'helpers.rb'), 'module InvoiceHelpers\nend', 'utf8');
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('InvoiceStatus')).toBe(true);
    expect(symbols.has('InvoiceHelpers')).toBe(true);
  });

  it('does not mistake a PHP import for a declaration', async () => {
    // `use function array_key_exists;` imports a BUILT-IN. Collecting it made the language's
    // own library look repo-specific — MEASURED, that deleted 7 of 167 blocks across the real
    // article corpus, every one a PHP article that merely mentioned `in_array()`.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-use-'));
    await writeFile(
      path.join(dir, 'thing.php'),
      [
        '<?php',
        'use function array_key_exists;',
        'use function is_numeric;',
        'function activit_build_row($x) { return $x; }',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'php');
    expect(symbols.has('array_key_exists')).toBe(false);
    expect(symbols.has('is_numeric')).toBe(false);
    expect(symbols.has('activit_build_row')).toBe(true);
  });

  it('ignores single-word names, which identify no repository', async () => {
    // bodyUsesRepoSymbol matches any `name(` in an article, so collecting `render` makes every
    // invented example that calls render(...) a citation and deletes its block. MEASURED on a
    // real 11,005-symbol repo: 16 of 17 commonplace method names were present, and a generic
    // example calling render(name) was flagged. 10,157 of those names are multi-word, so the
    // rule keeps 92% of the set and drops exactly the ambiguous tail.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-generic-'));
    await writeFile(
      path.join(dir, 'svc.ts'),
      [
        'class Svc {',
        '  render(x: string) { return x; }',
        '  execute(x: string) { return x; }',
        '  loadInvoiceBatch(x: string) { return x; }',
        '}',
        'const handle = (x: string) => x;',
        'const buildInvoiceRow = (x: string) => x;',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'typescript');
    expect(symbols.has('render')).toBe(false);
    expect(symbols.has('execute')).toBe(false);
    expect(symbols.has('handle')).toBe(false);
    // The distinctive ones still land.
    expect(symbols.has('loadInvoiceBatch')).toBe(true);
    expect(symbols.has('buildInvoiceRow')).toBe(true);
  });

  it('does not mistake control flow for a symbol', async () => {
    // These clear the length floor and match the method SHAPE, so only the name list excludes
    // them. Collecting one would make the scrub delete any article block that used the word.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-kw-'));
    await writeFile(
      path.join(dir, 'flow.ts'),
      ['function run() {', '  while (ready) {', '  }', '  switch (kind) {', '  }', '}'].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'typescript');
    expect(symbols.has('while')).toBe(false);
    expect(symbols.has('switch')).toBe(false);
  });
});
