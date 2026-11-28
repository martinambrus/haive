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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
});

describe('the plan snapshot routes', () => {
  it.each(['savePlanMirror', 'pullPlanMirror'])(
    'every call of %s sits in a route behind requireNewWorkAllowed, after an admitUnderFence outside any try',
    (name) => {
      const sf = parse('routes/plan.ts');
      const calls = callsOf(sf, name);
      expect(calls.length, `routes/plan.ts must call ${name}`).toBeGreaterThan(0);
      const bad: string[] = [];
      for (const call of calls) {
        let handler: ts.Node | undefined;
        for (let up = call.parent; up; up = up.parent) {
          if (
            (ts.isArrowFunction(up) || ts.isFunctionExpression(up)) &&
            ts.isCallExpression(up.parent) &&
            ts.isPropertyAccessExpression(up.parent.expression) &&
            up.parent.expression.name.text === 'post'
          ) {
            handler = up;
            break;
          }
        }
        const route = handler?.parent as ts.CallExpression | undefined;
        const gated =
          route !== undefined &&
          route.arguments.some((a) => ts.isIdentifier(a) && a.text === 'requireNewWorkAllowed');
        const fences = handler === undefined ? [] : callsOf(handler, 'admitUnderFence');
        const early = fences.filter((f) => {
          if (f.getStart() >= call.getStart()) return false;
          for (let up = f.parent; up && up !== handler; up = up.parent) {
            if (ts.isTryStatement(up)) return false;
          }
          return true;
        });
        if (!gated || early.length === 0) bad.push(where(sf, call));
      }
      expect(bad).toEqual([]);
    },
    30_000,
  );
});

describe('checkout mutations that start new work', () => {
  const WRAPPER = 'lib/admitted-checkout-mutation.ts';

  /** Every file under src other than the wrapper that calls `name` directly. */
  const directCallers = (name: string, extra?: ts.SourceFile): string[] => {
    const found: string[] = [];
    const scan = (file: string, sf: ts.SourceFile) => {
      if (file !== WRAPPER && callsOf(sf, name).length > 0) found.push(file);
    };
    for (const file of files()) scan(file, parse(file));
    if (extra) scan(extra.fileName, extra);
    return found;
  };

  it.each(['withCheckoutMutation', 'acquireRootClaim'])(
    'no file but the wrapper calls %s',
    (name) => {
      expect(directCallers(name)).toEqual([]);
    },
    30_000,
  );

  it.each(['withCheckoutMutation', 'acquireRootClaim'])(
    'the scan reports a synthetic direct call of %s',
    (name) => {
      const synthetic = ts.createSourceFile(
        'routes/synthetic.ts',
        `await ${name}(db, id, userId, async () => {});`,
        ts.ScriptTarget.Latest,
        true,
      );
      expect(directCallers(name, synthetic)).toContain('routes/synthetic.ts');
    },
    30_000,
  );

  it('acquireAdmittedRootClaim checks the state, then claims, then takes the fence', () => {
    const sf = parse(WRAPPER);
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'acquireAdmittedRootClaim',
    );
    expect(fn, 'the wrapper file must declare acquireAdmittedRootClaim').toBeDefined();
    const precheck = callsOf(fn!, 'assertNewWorkAllowed')[0];
    const claim = callsOf(fn!, 'acquireRootClaim')[0];
    const fence = callsOf(fn!, 'admitUnderFence')[0];
    expect(precheck, 'it must call assertNewWorkAllowed').toBeDefined();
    expect(claim, 'it must call acquireRootClaim').toBeDefined();
    expect(fence, 'it must call admitUnderFence').toBeDefined();
    expect(precheck!.getStart()).toBeLessThan(claim!.getStart());
    expect(claim!.getStart()).toBeLessThan(fence!.getStart());
  }, 30_000);

  it('the wrapper checks the state first and takes the fence inside the callback, before the work', () => {
    const sf = parse(WRAPPER);
    const precheck = callsOf(sf, 'assertNewWorkAllowed')[0];
    const claim = callsOf(sf, 'withCheckoutMutation')[0];
    expect(precheck, 'the wrapper must call assertNewWorkAllowed').toBeDefined();
    expect(claim, 'the wrapper must call withCheckoutMutation').toBeDefined();
    expect(precheck!.getStart()).toBeLessThan(claim!.getStart());

    const callback = claim!.arguments[3];
    expect(callback).toBeDefined();
    const fence = callsOf(callback!, 'admitUnderFence')[0];
    const work = callsOf(callback!, 'run')[0];
    expect(fence, 'the callback must call admitUnderFence').toBeDefined();
    expect(work, 'the callback must call run').toBeDefined();
    expect(fence!.getStart()).toBeLessThan(work!.getStart());
  }, 30_000);
});
