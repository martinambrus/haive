import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const ENTRIES = new Map([
  ['./step', path.join(SRC, 'step/index.ts')],
  ['./step/prompts', path.join(SRC, 'step/prompts.ts')],
  ['./step/review', path.join(SRC, 'step/review.ts')],
]);
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { import: string }>;
};

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

// Parse the emitted JavaScript as well as source: type-only dependencies must disappear at runtime.
function specifiersOf(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      // Even a computed runtime import violates the dependency-free entry contract.
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// Every entry walks a fresh closure, so parse each file once for the whole test.
const specifierCache = new Map<string, string[]>();
const cachedSpecifiers = (file: string): string[] => {
  let found = specifierCache.get(file);
  if (found === undefined) {
    found = specifiersOf(parse(file));
    specifierCache.set(file, found);
  }
  return found;
};

function closureOf(entry: string, seen = new Set<string>(), emitted = false): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of cachedSpecifiers(entry)) {
    if (spec.startsWith('.')) {
      closureOf(
        path.resolve(path.dirname(entry), emitted ? spec : spec.replace(/\.js$/, '.ts')),
        seen,
        emitted,
      );
    } else {
      const stepEntry = ENTRIES.get(spec.replace('@haive/shared/', './'));
      seen.add(stepEntry ?? spec);
    }
  }
  return seen;
}

describe('step SDK entry isolation', () => {
  it('emits no runtime imports or re-exports for the seven control classes', () => {
    expect(specifiersOf(parse(path.resolve(ROOT, manifest.exports['./step']!.import)))).toEqual([]);
  });

  it('maps each SDK entry to its own emitted types and JavaScript', () => {
    for (const [name, source] of ENTRIES) {
      const output = source.replace(SRC, './dist').replace(/\.ts$/, '');
      expect(manifest.exports[name], name).toEqual({
        types: `${output}.d.ts`,
        import: `${output}.js`,
      });
    }
  });

  it('keeps prompt runtime portable and review runtime limited to the designed crypto import', () => {
    for (const name of ['./step/prompts', './step/review']) {
      const entry = path.resolve(ROOT, manifest.exports[name]!.import);
      const external = [...closureOf(entry, new Set(), true)].filter(
        (file) => !file.startsWith(path.join(ROOT, 'dist') + path.sep),
      );
      expect(external, name).toEqual(name === './step/review' ? ['node:crypto'] : []);
    }
  }, 30_000);

  it('is unreachable from every other shared entry, including the root and web-used entries', () => {
    // Check all public entries, so a new web import needs no separate allowlist update.
    for (const [name, target] of Object.entries(manifest.exports)) {
      const source = path.join(SRC, target.import.replace('./dist/', '').replace(/\.js$/, '.ts'));
      const closure = closureOf(source);
      for (const [stepName, stepEntry] of ENTRIES) {
        // Review shares the portable prompt guards; no other entry may reach an SDK entry.
        if (name !== stepName && !(name === './step/review' && stepName === './step/prompts'))
          expect([...closure], `${name} -> ${stepName}`).not.toContain(stepEntry);
      }
    }
  }, 30_000);
});
