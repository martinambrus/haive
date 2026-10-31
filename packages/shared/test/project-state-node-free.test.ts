import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The web bundle reads conflicts.ts through @haive/shared/project-state-conflicts, so nothing it
// imports, however far down, may be a node module: the browser cannot resolve one. Nor may it read
// a node global (`Buffer`, `process`, ...): the browser defines none, so a call is a ReferenceError.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const NODE_GLOBALS: ReadonlySet<string> = new Set([
  'Buffer',
  'process',
  '__dirname',
  '__filename',
  'require',
  'module',
  'exports',
  'global',
  'setImmediate',
  'clearImmediate',
]);

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

/** The node globals a source reads as values, but for a property name (`x.Buffer`, `{ process: 1 }`),
 *  a type (`Buffer` as an annotation, erased) and an import or export specifier. */
function nodeGlobalsIn(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const named =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isMethodDeclaration(parent)) &&
        parent.name === node;
      const erased =
        ts.isTypeReferenceNode(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent);
      if (!named && !erased) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every module a file imports, re-exports or imports dynamically, but for `import type`, which is
 *  erased. */
function specifiersOf(source: ts.SourceFile): string[] {
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

/** The source files an entry reaches through relative imports, the node modules among their imports
 *  as `<file> -> <module>`, and the node globals they read as `<file> -> <global>`. */
function closureOf(entry: string): {
  files: string[];
  nodeImports: string[];
  nodeGlobals: string[];
} {
  const files = new Set<string>();
  const nodeImports: string[] = [];
  const nodeGlobals: string[] = [];
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = parse(file);
    for (const name of nodeGlobalsIn(source)) {
      nodeGlobals.push(`${path.relative(SRC, file)} -> ${name}`);
    }
    for (const spec of specifiersOf(source)) {
      if (spec.startsWith('.')) {
        walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      } else if (isNodeModule(spec)) {
        nodeImports.push(`${path.relative(SRC, file)} -> ${spec}`);
      }
    }
  };
  walk(path.join(SRC, entry));
  return { files: [...files].map((f) => path.relative(SRC, f)), nodeImports, nodeGlobals };
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

  it('read no node global either, however far down their imports go', () => {
    expect(closureOf('project-state/conflicts.ts').nodeGlobals).toEqual([]);
  });

  it('would be told of one: the scan finds a global read as a value and nothing else', () => {
    const scan = (text: string) =>
      nodeGlobalsIn(ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true));
    expect(scan("export const size = (t: string) => Buffer.byteLength(t, 'utf8');")).toEqual([
      'Buffer',
    ]);
    expect(scan('export const home = () => process.env.HOME;')).toEqual(['process']);
    expect(
      scan(
        'const a = x.Buffer; const o = { process: 1 }; let b: Buffer; import { global } from "m";',
      ),
    ).toEqual([]);
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
