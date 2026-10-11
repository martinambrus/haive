import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const ENDED = new Set(['failed', 'cancelled', 'completed']);
const GUARD = 'refuseReviveBesideLive';
const ONLY_CREATED = "eq(schema.tasks.status, 'created')";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The status a `.update(schema.tasks).set(...)` chain writes: its literal, `UNKNOWN` when the value
 *  or the object is computed and may carry one, or null when it writes no status. */
const UNKNOWN = '<computed>';

/** A property's name as the object sees it: `status`, `'status'` and `['status']` all read `status`;
 *  a computed name that is not a literal is `null`, which may be anything. */
function keyOf(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}
function writtenStatus(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'set') return null;
  let inner: ts.Expression = callee.expression;
  while (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner)) {
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === 'update'
    ) {
      if (inner.arguments[0]?.getText() !== 'schema.tasks') return null;
      const arg = call.arguments[0];
      if (!arg) return null;
      if (ts.isIdentifier(arg)) return objectMayCarryStatus(call, arg.text) ? UNKNOWN : null;
      if (!ts.isObjectLiteralExpression(arg)) return UNKNOWN;
      for (const p of arg.properties) {
        if (ts.isSpreadAssignment(p)) {
          if (!ts.isIdentifier(p.expression)) return UNKNOWN;
          if (objectMayCarryStatus(call, p.expression.text)) return UNKNOWN;
        } else if (keyOf(p.name) === null || keyOf(p.name) === 'status') {
          return ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)
            ? p.initializer.text
            : UNKNOWN;
        }
      }
      return null;
    }
    inner = inner.expression;
  }
  return null;
}

/** Whether the object a name holds may carry a `status`: it gains one in the function around the
 *  write, or it is not declared there at all (a parameter, an import, an outer binding). */
function objectMayCarryStatus(at: ts.Node, name: string): boolean {
  const fn = enclosingFunction(at);
  if (!fn) return true;
  let declared = false;
  let found = false;
  const visit = (n: ts.Node): void => {
    const assignedKey = ts.isPropertyAccessExpression(n)
      ? n.name.text
      : ts.isElementAccessExpression(n)
        ? ts.isStringLiteralLike(n.argumentExpression)
          ? n.argumentExpression.text
          : null
        : undefined;
    if (
      assignedKey !== undefined &&
      (assignedKey === null || assignedKey === 'status') &&
      (n as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression.getText() ===
        name &&
      ts.isBinaryExpression(n.parent) &&
      n.parent.left === n
    ) {
      found = true;
    }
    if (ts.isVariableDeclaration(n) && n.name.getText() === name) declared = true;
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText() === name &&
      n.initializer &&
      (!ts.isObjectLiteralExpression(n.initializer) ||
        n.initializer.properties.some(
          (p) => ts.isSpreadAssignment(p) || keyOf(p.name) === null || keyOf(p.name) === 'status',
        ))
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(fn);
  return found || !declared;
}

/** Whether the `.where(...)` after this `.set(...)` holds only a created task: the created equality
 *  is the predicate itself, or a direct conjunct of `and(...)`. */
function movesOnlyCreated(set: ts.CallExpression): boolean {
  const access = set.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'where') return false;
  const where = access.parent;
  if (!ts.isCallExpression(where)) return false;
  const pred = where.arguments[0];
  if (!pred) return false;
  if (pred.getText() === ONLY_CREATED) return true;
  return (
    ts.isCallExpression(pred) &&
    pred.expression.getText() === 'and' &&
    pred.arguments.some((a) => a.getText() === ONLY_CREATED)
  );
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) return n as ts.FunctionLikeDeclaration;
  }
  return null;
}

/** The innermost transaction callback holding the node, else its innermost function. */
function scopeOf(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
    const call = fn.parent;
    if (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'transaction'
    ) {
      return fn;
    }
  }
  return enclosingFunction(node);
}

function nameOf(fn: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

function isGuardStatement(st: ts.Statement): boolean {
  if (!ts.isExpressionStatement(st) || !ts.isAwaitExpression(st.expression)) return false;
  const call = st.expression.expression;
  return ts.isCallExpression(call) && call.expression.getText() === GUARD;
}

/** Whether a guard call runs on every path to the node: it is a statement earlier in one of the
 *  blocks that hold the node, within the node's scope. */
function dominated(node: ts.Node, scope: ts.Node): boolean {
  for (let child: ts.Node = node, n = node.parent; n && child !== scope; child = n, n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      const i = n.statements.indexOf(child as ts.Statement);
      if (i > 0 && n.statements.slice(0, i).some(isGuardStatement)) return true;
    }
  }
  return false;
}

/** Guarded on its own path: the guard dominates it within its scope, or its scope is a named
 *  function every call of which is guarded in turn. */
function guarded(sf: ts.SourceFile, node: ts.Node, depth = 0): boolean {
  const scope = scopeOf(node);
  if (!scope) return false;
  if (dominated(node, scope)) return true;
  const name = nameOf(scope);
  if (!name || depth > 3) return false;
  const calls: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.getText() === name) calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls.length > 0 && calls.every((c) => guarded(sf, c, depth + 1));
}

/** Every live-status write on a task row in one source, with whether it is covered. */
function liveWrites(
  file: string,
  text: string,
): { site: string; status: string; covered: boolean }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: { site: string; status: string; covered: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const status = writtenStatus(node);
      if (status !== null && !ENDED.has(status)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        out.push({
          site: `${file}:${line}`,
          status,
          covered: movesOnlyCreated(node) || guarded(sf, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// A write that puts a task row back to a live status revives it, so it must run the revival's
// exclusion on its own path, unless it only starts a task that was never live.
describe('a live-status write on a task row', () => {
  it(`calls ${GUARD} on its own path, or moves only a created task`, () => {
    const writes = sources(SRC).flatMap((f) =>
      liveWrites(relative(SRC, f), readFileSync(f, 'utf8')),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((w) => !w.covered)).toEqual([]);
  });

  it('does not count a guard in a sibling transaction', () => {
    const src = `async function route() {
      await db.transaction(async (tx) => { await ${GUARD}(tx, id); });
      await db.transaction(async (tx) => {
        await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      });
    }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('follows a closure to the transactions that call it', () => {
    const write = `tx.update(schema.tasks).set({ status: 'queued' }).where(eq(schema.tasks.id, id))`;
    const covered = (body: string) =>
      liveWrites('x.ts', `async function route() { const requeue = (tx) => ${write}; ${body} }`)[0]
        ?.covered;
    expect(
      covered(
        `await db.transaction(async (tx) => { await ${GUARD}(tx, id); await requeue(tx); });`,
      ),
    ).toBe(true);
    expect(covered(`await db.transaction(async (tx) => { await requeue(tx); });`)).toBe(false);
  });

  it('does not count a guard on another branch of the same transaction', () => {
    const src = `async function route() {
      await db.transaction(async (tx) => {
        if (allowed) await ${GUARD}(tx, id);
        else await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      });
    }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('does not count a guard in a nested closure nobody calls', () => {
    const src = `async function route() {
      await db.transaction(async (tx) => {
        const unused = async () => { await ${GUARD}(tx, id); };
        await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      });
    }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('checks a computed status or a patch that gains one', () => {
    const write = (body: string) =>
      liveWrites('x.ts', `async function f(next) { ${body} }`).map((w) => w.status);
    expect(
      write(`await db.update(schema.tasks).set({ status: next }).where(eq(schema.tasks.id, id));`),
    ).toEqual(['<computed>']);
    expect(
      write(
        `const patch = {}; patch.status = next; await db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual(['<computed>']);
    expect(
      write(
        `const patch = {}; patch.title = 't'; await db.update(schema.tasks).set({ ...patch, updatedAt: now }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([]);
  });

  it('does not count a guard call that is not awaited', () => {
    const src = `async function route() {
      await db.transaction(async (tx) => {
        ${GUARD}(tx, id);
        await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      });
    }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('treats a patch it cannot see declared as one that may carry a status', () => {
    const src = `async function f(patch) {
      await db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, id));
    }`;
    expect(liveWrites('x.ts', src).map((w) => w.status)).toEqual(['<computed>']);
  });

  it('reads a quoted or bracketed status key, and a bracket assignment', () => {
    const status = (body: string) =>
      liveWrites('x.ts', `async function f() { ${body} }`).map((w) => w.status);
    expect(status(`await db.update(schema.tasks).set({ 'status': 'running' });`)).toEqual([
      'running',
    ]);
    expect(status(`await db.update(schema.tasks).set({ ['status']: 'queued' });`)).toEqual([
      'queued',
    ]);
    expect(
      status(
        `const patch = {}; patch['status'] = 'running'; await db.update(schema.tasks).set(patch);`,
      ),
    ).toEqual(['<computed>']);
  });

  it('exempts only a predicate that holds a created task alone', () => {
    const covered = (where: string) =>
      liveWrites(
        'x.ts',
        `function f() { return db.update(schema.tasks).set({ status: 'queued' }).where(${where}); }`,
      )[0]?.covered;
    expect(covered(`and(eq(schema.tasks.id, id), ${ONLY_CREATED})`)).toBe(true);
    expect(covered(`or(${ONLY_CREATED}, eq(schema.tasks.status, 'failed'))`)).toBe(false);
    expect(
      covered(
        `and(eq(schema.tasks.id, id), or(${ONLY_CREATED}, eq(schema.tasks.status, 'failed')))`,
      ),
    ).toBe(false);
  });
});
