import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SANDBOX = join(import.meta.dirname, '../src/sandbox');
const RUNNER_MODULES = [
  'app-runner.ts',
  'ddev-runner.ts',
  'ddev-database-export.ts',
  'runner-browser-cdp.ts',
];
const FENCE = 'whileRunnerBusy';

function insideFence(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && n.expression.getText() === FENCE) return true;
  }
  return false;
}

function topLevelFunctionName(node: ts.Node): string | null {
  let name: string | null = null;
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
  }
  return name;
}

/** An attached `docker exec` in a runner, outside the fence that keeps a reap off it. */
function unfencedExecs(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const references = new Map<string, ts.Identifier[]>();
  const execs: ts.ArrayLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !ts.isFunctionDeclaration(node.parent)) {
      references.set(node.text, [...(references.get(node.text) ?? []), node]);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0]?.getText() === "'docker'" &&
      node.arguments[1] &&
      ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      const argv = node.arguments[1];
      const words = argv.elements.map((e) => e.getText());
      if (words[0] === "'exec'" && !words.includes("'-d'")) execs.push(argv);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return execs
    .filter((argv) => {
      if (insideFence(argv)) return false;
      const fn = topLevelFunctionName(argv);
      const refs = fn ? (references.get(fn) ?? []) : [];
      return refs.length === 0 || !refs.every(insideFence);
    })
    .map((argv) => `${file}:${sf.getLineAndCharacterOfPosition(argv.getStart()).line + 1}`);
}

// The reaper removes a runner it found settled; an exec that skips the fence can start under it.
describe('an attached docker exec into a runtime runner', () => {
  it(`runs inside ${FENCE}, or in a function only ever called there`, () => {
    expect(RUNNER_MODULES.flatMap((m) => unfencedExecs(join(SANDBOX, m)))).toEqual([]);
  });
});
