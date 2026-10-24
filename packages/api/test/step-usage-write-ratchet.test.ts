import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const OPEN = new Set(['pending', 'running', 'waiting_form', 'waiting_cli']);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.[cm]?tsx?$/.test(entry.name) && !/\.(test|d)\.[cm]?tsx?$/.test(entry.name)
        ? [path]
        : [];
  });
}

function key(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
    return name.expression.text;
  return undefined;
}

function violations(text: string, file: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const at = (node: ts.Node) =>
    `${file}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const declarations = new Map<string, ts.Expression[]>();
  const parkCalls: ts.Expression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const values = declarations.get(node.name.text) ?? [];
      values.push(node.initializer);
      declarations.set(node.name.text, values);
    }
    if (ts.isCallExpression(node) && node.expression.getText(src) === 'writeFencedPark') {
      if (node.arguments[3]) parkCalls.push(node.arguments[3]);
    }
    ts.forEachChild(node, collect);
  };
  collect(src);

  // Unknown status values are potentially terminal. Follow local patch objects and conditional
  // spreads rather than overlooking a terminal status hidden behind an identifier.
  const safe = (expr: ts.Expression, seen = new Set<string>()): boolean => {
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr)
    )
      return safe(expr.expression, seen);
    if (ts.isConditionalExpression(expr))
      return safe(expr.whenTrue, seen) && safe(expr.whenFalse, seen);
    if (ts.isIdentifier(expr)) {
      if (seen.has(expr.text)) return false;
      const values = declarations.get(expr.text);
      return (
        !!values?.length && values.every((value) => safe(value, new Set([...seen, expr.text])))
      );
    }
    if (!ts.isObjectLiteralExpression(expr)) return false;
    if (
      expr.properties.some(
        (p) => ts.isSpreadAssignment(p) && p.expression.getText(src) === 'CLEAR_STEP_USAGE_STAMP',
      )
    )
      return true;
    return expr.properties.every((p) => {
      if (ts.isSpreadAssignment(p)) return safe(p.expression, seen);
      const name = key(p.name);
      if (name === undefined) return false;
      if (name !== 'status') return true;
      return (
        ts.isPropertyAssignment(p) &&
        ts.isStringLiteralLike(p.initializer) &&
        OPEN.has(p.initializer.text)
      );
    });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'set'
    ) {
      const update = node.expression.expression;
      if (
        ts.isCallExpression(update) &&
        ts.isPropertyAccessExpression(update.expression) &&
        update.expression.name.text === 'update' &&
        update.arguments[0]?.getText(src) === 'schema.taskSteps'
      ) {
        const patch = node.arguments[0];
        // These are the two owned writers; their stepPatch behavior has runtime tests.
        const owned =
          file === 'packages/worker/src/step-engine/step-ownership.ts' &&
          patch &&
          ts.isCallExpression(patch) &&
          patch.expression.getText(src) === 'stepPatch';
        // The generic park writer's parameter can only be judged at ALL its local call sites.
        const park =
          file === 'packages/worker/src/queues/task-queue.ts' &&
          patch?.getText(src) === 'patch' &&
          parkCalls.length > 0 &&
          parkCalls.every((arg) => safe(arg));
        if (!owned && !park && (!patch || !safe(patch))) errors.push(at(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return errors;
}

describe('terminal step writers clear the previous usage stamp', () => {
  it('covers every direct taskSteps update in the api and worker sources', () => {
    const errors = ['packages/api/src', 'packages/worker/src'].flatMap((dir) =>
      sources(join(ROOT, dir)).flatMap((path) =>
        violations(readFileSync(path, 'utf8'), relative(ROOT, path)),
      ),
    );
    expect(errors).toEqual([]);
  }, 30_000);

  it.each([
    "{ status: 'done' }",
    "{ ['status']: 'failed' }",
    "{ status: stopped ? 'failed' : 'running' }",
    "{ ...{ status: 'skipped' } }",
    'patch',
  ])('refuses an uncleared finish: %s', (patch) => {
    expect(violations(`db.update(schema.taskSteps).set(${patch});`, 'sample.ts')).toHaveLength(1);
  });

  it('follows a local patch and accepts an explicit clear or an open write', () => {
    expect(
      violations(
        "const patch = { status: 'done' }; db.update(schema.taskSteps).set(patch);",
        'sample.ts',
      ),
    ).toHaveLength(1);
    expect(
      violations(
        "db.update(schema.taskSteps).set({ status: 'done', ...CLEAR_STEP_USAGE_STAMP }); db.update(schema.taskSteps).set({status: 'running'});",
        'sample.ts',
      ),
    ).toEqual([]);
  });
});
