import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SYMBOL_SCAN_EXT,
  collectRepoSymbols,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';
import {
  SERVER_LANGUAGES,
  STACK_INDICATORS,
} from '../src/step-engine/steps/onboarding/01-env-detect.js';

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

  it('ignores names the LANGUAGE owns, however they were declared', async () => {
    // A repo that declares `in_array` has written a shim or vendored a helper; it has not
    // coined a word. MEASURED across four checkouts: `is_string` arrived from a minified
    // jQuery plugin and `in_array` from a site's own `const in_array = ...`, each deleting a
    // block from the "PHP 8 Mistakes" article for naming the built-in it is about.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-builtin-'));
    await writeFile(
      path.join(dir, 'shim.php'),
      '<?php\nfunction in_array($n, $h) { return false; }\nfunction activit_row_key($x) { return $x; }',
      'utf8',
    );
    await writeFile(path.join(dir, 'helper.js'), 'const is_string = (a) => true;', 'utf8');
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('in_array')).toBe(false);
    expect(symbols.has('is_string')).toBe(false);
    expect(symbols.has('activit_row_key')).toBe(true);
  });

  it('skips a minified bundle, which is not this project vocabulary', async () => {
    // Detected by line LENGTH, not by a `.min.js` name a build tool can drop.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-min-'));
    const long = `function bundled_helper_name(a){return a}${'var padding_value=1;'.repeat(120)}`;
    await writeFile(path.join(dir, 'vendor-bundle.js'), long, 'utf8');
    await writeFile(path.join(dir, 'app.js'), 'function activit_real_helper(a){return a}', 'utf8');
    const symbols = await collectRepoSymbols(dir, 'javascript');
    expect(symbols.has('bundled_helper_name')).toBe(false);
    expect(symbols.has('activit_real_helper')).toBe(true);
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

  it('collects PascalCase names carrying a single-letter prefix', async () => {
    // `[a-z][A-Z]` alone misses this whole class shape — `CProduct` has no lowercase-then-
    // uppercase pair anywhere — so the repo that motivated the scrub had its own class names
    // dropped from the symbol set and a block copied out of one could not be recognised.
    // Same two-hump rule `identifiers.ts` already uses, and it must still reject capitalised
    // prose and all-caps words, or the scrub starts deleting invented examples.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-pascal-'));
    await writeFile(
      path.join(dir, 'classes.php'),
      [
        '<?php',
        'class CProduct { public function get() {} }',
        'class CPDF { public function get() {} }',
        'class Postgres { public function get() {} }',
        'class Excel { public function get() {} }',
        'class PDF { public function get() {} }',
        'class CNotificationEmail { public function get() {} }',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'php');
    expect(symbols.has('CProduct')).toBe(true);
    // Already collected through its `nE` hump, and must stay collected.
    expect(symbols.has('CNotificationEmail')).toBe(true);
    // Capitalised prose and all-caps names identify no repository: admitting them would let a
    // body that merely says "Postgres" or "PDF" lose the block around it.
    expect(symbols.has('Postgres')).toBe(false);
    expect(symbols.has('Excel')).toBe(false);
    expect(symbols.has('PDF')).toBe(false);
    expect(symbols.has('CPDF')).toBe(false);
  });

  it('collects Rust and Java declarations, which detection calls supported stacks', async () => {
    // `01-env-detect` maps Cargo.toml -> rust and pom.xml/build.gradle -> java, but the extension
    // map listed neither, and an unknown language falls back to the UNION of its values — so a
    // Rust or Java anchor contributed ZERO symbols and the scrub had no backstop there at all.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-rust-java-'));
    await writeFile(
      path.join(dir, 'invoice.rs'),
      [
        'pub struct InvoiceBatch { pub id: u32 }',
        'pub fn process_invoice_batch(b: &InvoiceBatch) -> u32 { b.id }',
        'pub trait InvoiceSink { fn accept(&self); }',
        'fn main() {}',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'Invoice.java'),
      [
        'public class InvoiceProcessor {',
        '  public void processInvoice() {}',
        '}',
        'record InvoiceRow(String id) {}',
        'interface InvoiceGateway {}',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('InvoiceBatch')).toBe(true);
    expect(symbols.has('process_invoice_batch')).toBe(true);
    expect(symbols.has('InvoiceSink')).toBe(true);
    expect(symbols.has('InvoiceProcessor')).toBe(true);
    expect(symbols.has('InvoiceRow')).toBe(true);
    expect(symbols.has('InvoiceGateway')).toBe(true);
    // `main` is single-word and below the length floor — the scan must not start collecting
    // vocabulary every project shares.
    expect(symbols.has('main')).toBe(false);
    // A return-typed method is read by `cFuncRe`, in Java exactly as in C# — the same shape, so
    // no reason to admit one and refuse the other. This assertion said `false` while that shape
    // was excluded; it is the assertion that caught the change when the pattern learned to see
    // an indented member.
    expect(symbols.has('processInvoice')).toBe(true);
  });

  it('collects Elixir declarations, including the def- forms `def` alone cannot reach', async () => {
    // `def` was already in the alternation for Python, but `\bdef\s+` cannot match `defp ` or
    // `defmodule `, so scanning `.ex` without those keywords would still have collected almost
    // nothing. They precede `def` in the alternation, or the shorter keyword wins and the name
    // group then starts mid-word.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-elixir-'));
    await writeFile(
      path.join(dir, 'invoice.ex'),
      [
        'defmodule InvoiceProcessor do',
        '  def process_invoice(batch) do',
        '    batch',
        '  end',
        '  defp normalise_invoice(batch), do: batch',
        '  defmacro with_invoice(do: block), do: block',
        'end',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('InvoiceProcessor')).toBe(true);
    expect(symbols.has('process_invoice')).toBe(true);
    expect(symbols.has('normalise_invoice')).toBe(true);
    expect(symbols.has('with_invoice')).toBe(true);
  });

  it('skips Elixir dependencies and build output', async () => {
    // `deps` is Elixir's dependency tree and `_build` its output — the same reasons `vendor`,
    // `node_modules` and `target` are already excluded. A dependency's functions are not this
    // project's vocabulary, and collecting them is how a generic name becomes a false citation.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-elixir-deps-'));
    await mkdir(path.join(dir, 'deps', 'jason', 'lib'), { recursive: true });
    await mkdir(path.join(dir, '_build'), { recursive: true });
    await writeFile(
      path.join(dir, 'deps', 'jason', 'lib', 'j.ex'),
      'def decode_payload(x), do: x',
      'utf8',
    );
    await writeFile(path.join(dir, '_build', 'gen.ex'), 'def generated_helper(x), do: x', 'utf8');
    await writeFile(path.join(dir, 'own.ex'), 'def own_project_fn(x), do: x', 'utf8');
    const symbols = await collectRepoSymbols(dir, 'elixir');
    expect(symbols.has('own_project_fn')).toBe(true);
    expect(symbols.has('decode_payload')).toBe(false);
    expect(symbols.has('generated_helper')).toBe(false);
  });

  it('collects C-family functions, which declare a RETURN TYPE and no keyword', async () => {
    // Neither `defRe` (wants a keyword) nor `methodRe` (wants the name straight after the
    // modifiers) can see these, so C, C++ and C# contributed TYPES only — and C has no classes,
    // so a C repository contributed almost nothing.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-cfamily-'));
    await writeFile(
      path.join(dir, 'invoice.c'),
      [
        '#include <stdio.h>',
        'int process_invoice_batch(struct Batch *b) {',
        '  return b->id;',
        '}',
        'static inline unsigned compute_checksum(const char *s) {',
        '  return 0;',
        '}',
        'int prototype_only_fn(void);',
        'void run(void) {',
        '  if (condition_value) {',
        '    indented_call(argument);',
        '  }',
        '  for (int i = 0; i < 3; i++) {}',
        '}',
      ].join('\n'),
      'utf8',
    );
    // REAL C# formatting: the member is indented inside its class. The first version of this
    // fixture put it at column 0 to match the pattern, which is the wrong way round — it proved
    // the regex matched itself rather than that it reads C#.
    await writeFile(
      path.join(dir, 'Invoice.cs'),
      [
        'public class InvoiceService {',
        '    public void ProcessInvoice(int id) {',
        '        if (condition_value) {',
        '            indented_call(id);',
        '        }',
        '        foreach (var item_value in items) {}',
        '    }',
        '    private static Task ComputeTotalAsync(Order o) {',
        '        return null;',
        '    }',
        '    public string FormatInvoice(int id) => id.ToString();',
        '    public int TotalCount => items.Count;',
        '    public int OtherCount { get; set; }',
        '}',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, null);
    expect(symbols.has('process_invoice_batch')).toBe(true);
    expect(symbols.has('compute_checksum')).toBe(true);
    expect(symbols.has('ProcessInvoice')).toBe(true);
    expect(symbols.has('ComputeTotalAsync')).toBe(true);
    // Indented control flow is still not a symbol, which is what the brace requirement buys.
    expect(symbols.has('item_value')).toBe(false);
    expect(symbols.has('TotalCount')).toBe(false);
    // C#'s expression-bodied member is a declaration too; a property using `=>` is not, because
    // it has no parens.
    expect(symbols.has('FormatInvoice')).toBe(true);
    // A prototype declares no body, and control flow is not a symbol however it is written.
    expect(symbols.has('prototype_only_fn')).toBe(false);
    expect(symbols.has('condition_value')).toBe(false);
    expect(symbols.has('indented_call')).toBe(false);
  });

  it('skips SwiftPM and CocoaPods dependency trees', async () => {
    // `.build/checkouts/<dep>/Sources` is a DEPENDENCY's source. Collecting it makes a library
    // API the article legitimately names read as repository-private, and the block is deleted —
    // the false-citation direction, which costs somebody's prose rather than a missed symbol.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-swift-'));
    await mkdir(path.join(dir, '.build', 'checkouts', 'dep', 'Sources'), { recursive: true });
    await mkdir(path.join(dir, 'Pods', 'Alamofire'), { recursive: true });
    await writeFile(
      path.join(dir, '.build', 'checkouts', 'dep', 'Sources', 'Dep.swift'),
      'public func dependency_helper_fn() {}',
      'utf8',
    );
    await writeFile(
      path.join(dir, 'Pods', 'Alamofire', 'A.swift'),
      'public func pod_helper_fn() {}',
      'utf8',
    );
    await writeFile(path.join(dir, 'Own.swift'), 'public func own_project_fn() {}', 'utf8');
    const symbols = await collectRepoSymbols(dir, 'swift');
    expect(symbols.has('own_project_fn')).toBe(true);
    expect(symbols.has('dependency_helper_fn')).toBe(false);
    expect(symbols.has('pod_helper_fn')).toBe(false);
  });

  it('skips a Python virtualenv, which is a dependency tree', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-venv-'));
    await mkdir(path.join(dir, '.venv', 'lib', 'site-packages'), { recursive: true });
    await mkdir(path.join(dir, 'venv', 'lib'), { recursive: true });
    await writeFile(
      path.join(dir, '.venv', 'lib', 'site-packages', 'dep.py'),
      'def library_helper_fn(x):\n    return x\n',
      'utf8',
    );
    await writeFile(
      path.join(dir, 'venv', 'lib', 'other.py'),
      'def other_library_fn(x):\n    return x\n',
      'utf8',
    );
    await writeFile(path.join(dir, 'own.py'), 'def own_project_fn(x):\n    return x\n', 'utf8');
    // tox and nox build their own per-environment virtualenvs, reached by a different tool.
    await mkdir(path.join(dir, '.tox', 'py311', 'lib'), { recursive: true });
    await mkdir(path.join(dir, '.nox', 'tests', 'lib'), { recursive: true });
    await writeFile(
      path.join(dir, '.tox', 'py311', 'lib', 'tox_dep.py'),
      'def tox_library_fn(x):\n    return x\n',
      'utf8',
    );
    await writeFile(
      path.join(dir, '.nox', 'tests', 'lib', 'nox_dep.py'),
      'def nox_library_fn(x):\n    return x\n',
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'python');
    expect(symbols.has('own_project_fn')).toBe(true);
    expect(symbols.has('library_helper_fn')).toBe(false);
    expect(symbols.has('other_library_fn')).toBe(false);
    expect(symbols.has('tox_library_fn')).toBe(false);
    expect(symbols.has('nox_library_fn')).toBe(false);
  });

  it('skips Rust build output, which is generated rather than project vocabulary', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-rust-target-'));
    await mkdir(path.join(dir, 'target'), { recursive: true });
    await writeFile(
      path.join(dir, 'target', 'generated.rs'),
      'pub fn generated_helper_fn() {}',
      'utf8',
    );
    await writeFile(path.join(dir, 'real.rs'), 'pub fn real_project_fn() {}', 'utf8');
    const symbols = await collectRepoSymbols(dir, 'rust');
    expect(symbols.has('real_project_fn')).toBe(true);
    expect(symbols.has('generated_helper_fn')).toBe(false);
  });

  it('collects a TypeScript method that declares a return type', async () => {
    // The annotation sits between `)` and `{`, and requiring the brace immediately after the
    // parens skipped every typed method — which in a TS repo is most of them.
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-ts-'));
    await writeFile(
      path.join(dir, 'repo.ts'),
      [
        'class InvoiceRepo {',
        '  serializeInvoice(): string {',
        '    return "";',
        '  }',
        '  async loadInvoiceBatch(id: string): Promise<string[]> {',
        '    return [];',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'typescript');
    expect(symbols.has('serializeInvoice')).toBe(true);
    expect(symbols.has('loadInvoiceBatch')).toBe(true);
  });

  it('collects accessors, generic methods and arrow class properties', async () => {
    // Five of seven common JS/TS declaration forms were invisible. `get`/`set` are keyword
    // extensions; the generic and the arrow property are narrow shape extensions, each
    // anchored on something unambiguous (`<...>(` and `=>`).
    const dir = await mkdtemp(path.join(tmpdir(), 'symbols-forms-'));
    await writeFile(
      path.join(dir, 'view.ts'),
      [
        'class InvoiceView {',
        '  get invoiceTotal(): number {',
        '    return 1;',
        '  }',
        '  loadInvoiceRows<T>(id: string): T[] {',
        '    return [];',
        '  }',
        '  handleUserClick = (e: Event) => {',
        '    return e;',
        '  };',
        '  timeoutValue = 30;',
        '}',
      ].join('\n'),
      'utf8',
    );
    const symbols = await collectRepoSymbols(dir, 'typescript');
    expect(symbols.has('invoiceTotal')).toBe(true);
    expect(symbols.has('loadInvoiceRows')).toBe(true);
    expect(symbols.has('handleUserClick')).toBe(true);
    // A plain value property is not a callable and must not be collected.
    expect(symbols.has('timeoutValue')).toBe(false);
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

// Rust, Java and Elixir each went missing the same way: `01-env-detect` recognised the stack, the
// scan could not read its files, and because an unknown language falls back to the UNION of this
// map the fallback could not rescue them either — the repository's own identifiers were invisible
// to the citation scrub. Asserted structurally so the next language added to the detector fails
// here rather than silently shipping a blind spot.
describe('symbol scan coverage', () => {
  it('reads every language the MANIFEST detector can report', () => {
    const detected = [...new Set(STACK_INDICATORS.map((i) => i.language))].sort();
    const missing = detected.filter((lang) => !SYMBOL_SCAN_EXT[lang]);
    expect(missing).toEqual([]);
  });

  it('reads every language the HISTOGRAM detector can report', () => {
    // Two independent sources of a language name, which is what made the first version of this
    // test insufficient: `pickPrimaryLanguage` never consults the manifest markers — it ranks an
    // ingest histogram and returns a SERVER_LANGUAGES member lowercased. Keying the coverage
    // check on one list left C#, Kotlin, Scala, Swift, C and C++ blind.
    const detected = [...SERVER_LANGUAGES].map((l) => l.toLowerCase()).sort();
    const missing = detected.filter((lang) => !SYMBOL_SCAN_EXT[lang]);
    expect(missing).toEqual([]);
  });
});
