import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The web bundle reads conflicts.ts through @haive/shared/project-state-conflicts, so nothing it
// imports, however far down, may be a node module: the browser cannot resolve one.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every module a file imports, re-exports or imports dynamically, but for `import type`, which is
 *  erased. */
function specifiersOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !(ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const isNodeModule = (spec: string): boolean =>
  spec.startsWith('node:') || builtinModules.includes(spec);

/** The source files an entry reaches through relative imports, and the node modules among their
 *  imports as `<file> -> <module>`. */
function closureOf(entry: string): { files: string[]; nodeImports: string[] } {
  const files = new Set<string>();
  const nodeImports: string[] = [];
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith('.')) {
        walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      } else if (isNodeModule(spec)) {
        nodeImports.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
  };
  walk(path.join(SRC, entry));
  return { files: [...files].map((f) => path.relative(SRC, f)), nodeImports };
}

describe('the conflict unit helpers the web bundle reads', () => {
  it('reach no node module, however far down their imports go', () => {
    const { files, nodeImports } = closureOf('project-state/conflicts.ts');
    expect(files).toContain('project-state/settings.ts');
    expect(nodeImports).toEqual([]);
  });

  it('would be told of one: the walk finds the node import under the template manifest', () => {
    expect(closureOf('templates/manifest.ts').nodeImports).toContain(
      'templates/manifest.ts -> node:crypto',
    );
  });

  it('take normalizeContent from a leaf of its own, which the manifest still exports', async () => {
    expect(closureOf('templates/normalize-content.ts').files).toEqual([
      'templates/normalize-content.ts',
    ]);
    const manifest = await import('../src/templates/manifest.js');
    const leaf = await import('../src/templates/normalize-content.js');
    expect(manifest.normalizeContent).toBe(leaf.normalizeContent);
  });
});
