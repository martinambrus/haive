import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const LOCKING = new Set([
  'lockRepositoryTasksKey',
  'lockRepositoryRow',
  'lockPlanMerge',
  'reviveRefusal',
]);
const WRAPPER = 'boundedLockWait';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(ts|mts|cts|tsx)$/.test(e.name) && !/\.(test|d)\.[mc]?tsx?$/.test(e.name)
      ? [path]
      : [];
  });
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : null;

function insideWrappedTake(node: ts.Node): boolean {
  for (let cur = node; cur.parent; cur = cur.parent) {
    const parent = cur.parent;
    if (
      ts.isCallExpression(parent) &&
      calleeName(parent) === WRAPPER &&
      parent.arguments[1] === cur &&
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))
    ) {
      return true;
    }
  }
  return false;
}

/** Follow the receiver chain only; repository subqueries in WHERE are not the locked table. */
function directRepositoryTake(call: ts.CallExpression): boolean {
  const mode = call.arguments[0];
  if (calleeName(call) !== 'for' || !mode || !ts.isStringLiteral(mode)) return false;
  if (!['update', 'no key update'].includes(mode.text)) return false;
  let receiver: ts.Expression = call.expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(receiver) ||
      ts.isNonNullExpression(receiver) ||
      ts.isAsExpression(receiver)
    ) {
      receiver = receiver.expression;
    } else if (ts.isPropertyAccessExpression(receiver)) {
      receiver = receiver.expression;
    } else if (ts.isCallExpression(receiver)) {
      if (calleeName(receiver) === 'from') {
        const table = receiver.arguments[0];
        return (
          !!table &&
          ts.isPropertyAccessExpression(table) &&
          ts.isIdentifier(table.expression) &&
          table.expression.text === 'schema' &&
          table.name.text === 'repositories'
        );
      }
      receiver = receiver.expression;
    } else return false;
  }
}

/** `file:line` of every lock-taking call that is not inside the function passed as the second argument of `boundedLockWait`. */
export function unwrappedLockCalls(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (
        ((name !== null && LOCKING.has(name)) || directRepositoryTake(n)) &&
        !insideWrappedTake(n)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(n.getStart(source));
        found.push(`${file}:${line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return found;
}

describe('the repository lock is only taken through boundedLockWait', () => {
  it.each(['update', 'no key update'])(
    'flags direct repository FOR %s selects, including chained and multiline calls',
    (mode) => {
      const take = `tx.select().from(schema.repositories)\n  .where(eq(schema.repositories.id, id)).limit(1).for('${mode}')`;
      expect(unwrappedLockCalls('direct.ts', take)).toEqual(['direct.ts:1']);
      expect(unwrappedLockCalls('wrapped.ts', `boundedLockWait(tx, async () => ${take})`)).toEqual(
        [],
      );
      expect(unwrappedLockCalls('wrong.ts', `boundedLockWait(() => ${take}, tx)`)).toEqual([
        'wrong.ts:1',
      ]);
      expect(
        unwrappedLockCalls('other.ts', `tx.select().from(schema.tasks).for('${mode}')`),
      ).toEqual([]);
    },
  );

  it('allows compatible KEY SHARE takes and does not confuse a subquery with the selected table', () => {
    expect(
      unwrappedLockCalls('share.ts', `tx.select().from(schema.repositories).for('key share')`),
    ).toEqual([]);
    expect(
      unwrappedLockCalls(
        'subquery.ts',
        `tx.select().from(schema.tasks).where(exists(tx.select().from(schema.repositories))).for('update')`,
      ),
    ).toEqual([]);
  });
  it('flags an unwrapped call and accepts a wrapped one', () => {
    const unwrapped = `async function f(tx) {\n  await lockRepositoryTasksKey(tx, id);\n}`;
    expect(unwrappedLockCalls('a.ts', unwrapped)).toEqual(['a.ts:2']);
    const wrapped = `async function f(tx) {\n  await boundedLockWait(tx, () => lockRepositoryRow(tx, id));\n  await boundedLockWait(tx, async () => {\n    await reviveRefusal(tx, id);\n  });\n}`;
    expect(unwrappedLockCalls('b.ts', wrapped)).toEqual([]);
    const firstArgument = `boundedLockWait(() => lockRepositoryRow(tx, id), tx);`;
    expect(unwrappedLockCalls('c.ts', firstArgument)).toEqual(['c.ts:1']);
  });

  it('finds no lock call in packages/api/src outside it', () => {
    const unwrapped = sources(SRC).flatMap((file) =>
      unwrappedLockCalls(relative(SRC, file), readFileSync(file, 'utf8')),
    );
    expect(unwrapped).toEqual([]);
    // A parse of every api source file: well under a second on a quiet host, but a loaded runner can
    // pass the 5 s default, as new-work-fence-order.test.ts's source walk did (T372).
  }, 30_000);
});
