import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const FENCE = 'admitNewWork';

const files = () =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .sort();
const parse = (file: string) =>
  ts.createSourceFile(file, readFileSync(join(SRC, file), 'utf8'), ts.ScriptTarget.Latest, true);
const where = (sf: ts.SourceFile, node: ts.Node) =>
  `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

/** Every call of the function `name` under `root`, in source order. */
function callsOf(root: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** What a call hands its work to: the literal last argument, or the const it names in the same file. */
function callbackOf(sf: ts.SourceFile, call: ts.CallExpression): ts.Node | undefined {
  const last = call.arguments.at(-1);
  if (!last || !ts.isIdentifier(last)) return last;
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === last.text
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The nearest function around `node` that is handed to a `.transaction(` call. */
function transactionAround(node: ts.Node): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let up = node.parent; up; up = up.parent) {
    if (
      (ts.isArrowFunction(up) || ts.isFunctionExpression(up)) &&
      ts.isCallExpression(up.parent) &&
      ts.isPropertyAccessExpression(up.parent.expression) &&
      up.parent.expression.name.text === 'transaction'
    ) {
      return up;
    }
  }
  return undefined;
}

/** The fence goes first in every admission, or the lock it holds while waiting for it closes a cycle. */
describe('the new-work fence and the locks an admission takes', () => {
  it('withRepositoryTaskLock admits the new work before it takes the repository lock', () => {
    const sf = parse('routes/upgrades.ts');
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'withRepositoryTaskLock',
    );
    expect(fn).toBeDefined();

    const fence = callsOf(fn!, FENCE)[0];
    const lock = callsOf(fn!, 'lockRepositoryTasks')[0];

    expect(fence, 'withRepositoryTaskLock must call admitNewWork').toBeDefined();
    expect(lock).toBeDefined();
    expect(fence!.getStart()).toBeLessThan(lock!.getStart());
  });

  it('no caller of withRepositoryTaskLock or insertUpgradeTask admits the new work again, after the lock', () => {
    const late: string[] = [];
    let callers = 0;
    for (const file of files()) {
      const sf = parse(file);
      for (const name of ['withRepositoryTaskLock', 'insertUpgradeTask']) {
        for (const call of callsOf(sf, name)) {
          callers += 1;
          const callback = callbackOf(sf, call);
          if (callback && callsOf(callback, FENCE).length > 0)
            late.push(`${where(sf, call)} ${name}`);
        }
      }
    }

    expect(callers, 'the scan found fewer callers than the sources have').toBeGreaterThanOrEqual(5);
    expect(late).toEqual([]);
  });

  it('every transaction handed to spawnPlanTask takes the fence before it locks anything', () => {
    const sf = parse('routes/plan.ts');
    const handed = callsOf(sf, 'spawnPlanTask').filter((call) => {
      const options = call.arguments[0];
      return (
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some((p) => p.name !== undefined && p.name.getText() === 'db')
      );
    });
    const notFirst = handed.filter((call) => {
      const tx = transactionAround(call);
      const first = tx !== undefined && ts.isBlock(tx.body) ? tx.body.statements[0] : undefined;
      const awaited =
        first !== undefined && ts.isExpressionStatement(first) ? first.expression : undefined;
      const fenced =
        awaited !== undefined &&
        ts.isAwaitExpression(awaited) &&
        ts.isCallExpression(awaited.expression) &&
        ts.isIdentifier(awaited.expression.expression) &&
        awaited.expression.expression.text === FENCE;
      return !fenced;
    });

    expect(handed.length, 'the scan found no transaction handed to spawnPlanTask').toBeGreaterThan(
      0,
    );
    expect(notFirst.map((call) => where(sf, call))).toEqual([]);
  });
});
