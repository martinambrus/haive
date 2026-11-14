import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const STEP = path.join(SRC, 'step/index.ts');
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

function closureOf(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const spec of cachedSpecifiers(entry)) {
    if (spec.startsWith('.')) {
      closureOf(path.resolve(path.dirname(entry), spec.replace(/\.js$/, '.ts')), seen);
    } else if (spec === '@haive/shared/step') {
      seen.add(STEP);
    }
  }
  return seen;
}

describe('step SDK entry isolation', () => {
  it('emits no runtime imports or re-exports for the six control classes', () => {
    expect(specifiersOf(parse(path.resolve(ROOT, manifest.exports['./step']!.import)))).toEqual([]);
  });

  it('is unreachable from every other shared entry, including the root and web-used entries', () => {
    // Check all public entries, so a new web import needs no separate allowlist update.
    for (const [name, target] of Object.entries(manifest.exports)) {
      if (name === './step') continue;
      const source = path.join(SRC, target.import.replace('./dist/', '').replace(/\.js$/, '.ts'));
      expect([...closureOf(source)], name).not.toContain(STEP);
    }
  });
});
