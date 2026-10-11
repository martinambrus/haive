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
      // Later properties override earlier ones, so the last that may carry a status decides.
      let status: string | null = null;
      for (const p of arg.properties) {
        if (ts.isSpreadAssignment(p)) {
          if (!ts.isIdentifier(p.expression) || objectMayCarryStatus(call, p.expression.text)) {
            status = UNKNOWN;
          }
        } else if (keyOf(p.name) === null || keyOf(p.name) === 'status') {
          status =
            ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)
              ? p.initializer.text
              : UNKNOWN;
        }
      }
      return status;
    }
    inner = inner.expression;
  }
  return null;
}

/** The declaration `name` resolves to at `at`, read lexically: the innermost scope that binds it.
 *  `'opaque'` for a binding whose value this file cannot see (a parameter, an import, a catch or
 *  loop variable), null when nothing in the file binds it. */
function bindingOf(at: ts.Node, name: string): ts.VariableDeclaration | 'opaque' | null {
  const named = (b: ts.BindingName): boolean =>
    ts.isIdentifier(b)
      ? b.text === name
      : b.elements.some((e) => !ts.isOmittedExpression(e) && named(e.name));
  const varIn = (scope: ts.Node, blockScoped: boolean): ts.VariableDeclaration | null => {
    let hit: ts.VariableDeclaration | null = null;
    const visit = (n: ts.Node): void => {
      if (hit || (n !== scope && ts.isFunctionLike(n))) return;
      if (ts.isVariableDeclarationList(n)) {
        const isVar = (n.flags & ts.NodeFlags.BlockScoped) === 0;
        if (isVar !== blockScoped) {
          hit = n.declarations.find((d) => named(d.name)) ?? null;
        }
      }
      if (blockScoped && n !== scope && (ts.isBlock(n) || ts.isIterationStatement(n, false)))
        return;
      ts.forEachChild(n, visit);
    };
    if (
      blockScoped &&
      (ts.isBlock(scope) ||
        ts.isSourceFile(scope) ||
        ts.isModuleBlock(scope) ||
        ts.isCaseClause(scope) ||
        ts.isDefaultClause(scope))
    ) {
      for (const st of scope.statements) {
        if (ts.isVariableStatement(st)) visit(st.declarationList);
      }
    } else if (!blockScoped) {
      ts.forEachChild(scope, visit);
    }
    return hit;
  };
  for (let n: ts.Node | undefined = at; n; n = n.parent) {
    const lexical = varIn(n, true);
    if (lexical) return ts.isIdentifier(lexical.name) ? lexical : 'opaque';
    if (
      (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) &&
      n.initializer
    ) {
      if (ts.isVariableDeclarationList(n.initializer)) {
        if (n.initializer.declarations.some((d) => named(d.name))) return 'opaque';
      }
    }
    if (ts.isCatchClause(n) && n.variableDeclaration && named(n.variableDeclaration.name)) {
      return 'opaque';
    }
    if (ts.isFunctionLike(n)) {
      if (n.parameters.some((p) => named(p.name))) return 'opaque';
      const hoisted = varIn(n, false);
      if (hoisted) return ts.isIdentifier(hoisted.name) ? hoisted : 'opaque';
    }
    if (ts.isSourceFile(n)) {
      const hoisted = varIn(n, false);
      if (hoisted) return ts.isIdentifier(hoisted.name) ? hoisted : 'opaque';
      const imported = n.statements.some((st) => {
        const clause = ts.isImportDeclaration(st) ? st.importClause : undefined;
        if (!clause) return false;
        if (clause.name?.text === name) return true;
        const nb = clause.namedBindings;
        if (!nb) return false;
        return ts.isNamespaceImport(nb)
          ? nb.name.text === name
          : nb.elements.some((e) => e.name.text === name);
      });
      if (imported) return 'opaque';
    }
  }
  return null;
}

/** Whether an expression is written to: an assignment's left side, a destructuring target inside
 *  one, an increment, a `delete`, or a `for…of`/`for…in` binding. */
function isWriteTarget(n: ts.Node): boolean {
  for (let cur = n, p = n.parent; p; cur = p, p = p.parent) {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isObjectLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === cur)
    ) {
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      return (
        p.left === cur &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isDeleteExpression(p)) return true;
    return (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur;
  }
  return false;
}

/** Whether a use of the patch could change it: anything but reading one of its properties or
 *  handing it to a `.set(...)`, since a helper, an alias or a replacement may give it a status. */
function escapes(use: ts.Identifier): boolean {
  const p = use.parent;
  const named = p as { name?: ts.Node };
  if (
    named.name === use &&
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isPropertyAccessExpression(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p))
  ) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
    p.expression === use
  ) {
    // A method of the patch may set its status through `this`.
    return ts.isCallExpression(p.parent) && p.parent.expression === p;
  }
  if (ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) return false;
  return !(
    ts.isCallExpression(p) &&
    ts.isPropertyAccessExpression(p.expression) &&
    p.expression.name.text === 'set' &&
    p.arguments.includes(use)
  );
}

/** Whether the object a name holds may carry a `status`: its own declaration's initializer may, or
 *  the scope that declares it assigns into it or replaces it; a binding this file cannot see may. */
function objectMayCarryStatus(at: ts.Node, name: string): boolean {
  const decl = bindingOf(at, name);
  if (decl === null || decl === 'opaque') return true;
  const init = decl.initializer;
  if (
    !init ||
    !ts.isObjectLiteralExpression(init) ||
    init.properties.some(
      (p) => ts.isSpreadAssignment(p) || keyOf(p.name) === null || keyOf(p.name) === 'status',
    )
  ) {
    return true;
  }
  const list = decl.parent;
  const scope =
    (list.flags & ts.NodeFlags.BlockScoped) !== 0
      ? list.parent.parent
      : (enclosingFunction(decl) ?? decl.getSourceFile());
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
      isWriteTarget(n)
    ) {
      found = true;
    }
    if (ts.isIdentifier(n) && n.text === name && n !== decl.name && escapes(n)) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
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

/** The innermost function holding the node: a callback may run after the transaction around it has
 *  ended, so no guard outside a function covers a write inside it. A named one is checked at its
 *  call sites instead. */
function scopeOf(node: ts.Node): ts.FunctionLikeDeclaration | null {
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
/** A `.update(schema.tasks)` not chained straight into `.set(...)`: whatever later sets its status
 *  is out of sight, so the builder itself is the write. */
function detachedTaskBuilder(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'update' &&
    call.arguments[0]?.getText() === 'schema.tasks' &&
    !(ts.isPropertyAccessExpression(call.parent) && call.parent.name.text === 'set')
  );
}

function liveWrites(
  file: string,
  text: string,
): { site: string; status: string; covered: boolean }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: { site: string; status: string; covered: boolean }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const status = detachedTaskBuilder(node) ? UNKNOWN : writtenStatus(node);
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

/** An import from the database package that reaches the tasks table under another name: `tasks`
 *  itself, a namespace, or `schema` renamed. */
function importRenamesTasks(decl: ts.ImportDeclaration): boolean {
  const from = (decl.moduleSpecifier as ts.StringLiteral).text;
  const bindings = decl.importClause?.namedBindings;
  if (!from.startsWith('@haive/database') || !bindings) return false;
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((e) => {
    const imported = (e.propertyName ?? e.name).text;
    return imported === 'tasks' || (imported === 'schema' && e.name.text !== 'schema');
  });
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

  it('does not let a guard outside an anonymous callback cover a write inside it', () => {
    const covered = (body: string) =>
      liveWrites(
        'x.ts',
        `async function route() { await db.transaction(async (tx) => { ${body} }); }`,
      ).map((w) => w.covered);
    expect(
      covered(
        `await ${GUARD}(tx, id); queueMicrotask(() => tx.update(schema.tasks).set({ status: 'running' }));`,
      ),
    ).toEqual([false]);
    expect(
      covered(
        `queueMicrotask(async () => { await ${GUARD}(tx, id); await tx.update(schema.tasks).set({ status: 'running' }); });`,
      ),
    ).toEqual([true]);
  });

  it('checks a named function inside a transaction at its call sites', () => {
    const covered = (body: string) =>
      liveWrites(
        'x.ts',
        `async function route() { await db.transaction(async (tx) => { ${body} function run() { return tx.update(schema.tasks).set({ status: 'running' }); } }); }`,
      ).map((w) => w.covered);
    expect(covered(`await run(); await ${GUARD}(tx, id);`)).toEqual([false]);
    expect(covered(`await ${GUARD}(tx, id); await run();`)).toEqual([true]);
  });

  // Every check here reads a task-row write by its `schema.tasks` text, so nothing may rename it.
  it('finds schema.tasks under no other name in the sources it checks', () => {
    const aliases = sources(SRC).flatMap((f) => {
      const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
      const out: string[] = [];
      const visit = (n: ts.Node): void => {
        if (
          (ts.isVariableDeclaration(n) && n.initializer?.getText() === 'schema.tasks') ||
          (ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            n.right.getText() === 'schema.tasks') ||
          (ts.isVariableDeclaration(n) &&
            ts.isObjectBindingPattern(n.name) &&
            n.initializer?.getText() === 'schema' &&
            n.name.elements.some((e) => (e.propertyName ?? e.name).getText() === 'tasks')) ||
          (ts.isImportDeclaration(n) && importRenamesTasks(n))
        ) {
          out.push(
            `${relative(SRC, f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
          );
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    });
    expect(aliases).toEqual([]);
  });

  it('reads an import that renames the tasks table as an alias', () => {
    const renames = (text: string) => {
      const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
      return importRenamesTasks(sf.statements[0] as ts.ImportDeclaration);
    };
    expect(renames(`import { tasks } from '@haive/database/schema';`)).toBe(true);
    expect(renames(`import { tasks as t } from '@haive/database';`)).toBe(true);
    expect(renames(`import * as db from '@haive/database/schema';`)).toBe(true);
    expect(renames(`import { schema as s } from '@haive/database';`)).toBe(true);
    expect(renames(`import { schema, type Database } from '@haive/database';`)).toBe(false);
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

  it('reads the status the last property leaves, a spread after a literal included', () => {
    const status = (set: string) =>
      liveWrites(
        'x.ts',
        `async function f(patch) { await db.update(schema.tasks).set(${set}); }`,
      ).map((w) => w.status);
    expect(status(`{ status: 'failed', ...patch }`)).toEqual(['<computed>']);
    expect(status(`{ ...patch, status: 'failed' }`)).toEqual([]);
  });

  it('reads the patch binding visible at the write, not a namesake elsewhere', () => {
    const count = (src: string) => liveWrites('x.ts', src).length;
    expect(
      count(
        `async function f(patch) { if (x) { const patch = {}; } await db.update(schema.tasks).set(patch); }`,
      ),
    ).toBe(1);
    expect(
      count(
        `const patch = { title: 't' }; async function f() { { const patch = { status: 'running' }; } await db.update(schema.tasks).set(patch); }`,
      ),
    ).toBe(0);
    expect(
      count(
        `import { patch } from './p.js'; async function f() { await db.update(schema.tasks).set(patch); }`,
      ),
    ).toBe(1);
    expect(
      count(
        `import { patchy } from './p.js'; const patch = { title: 't' }; async function f() { await db.update(schema.tasks).set(patch); }`,
      ),
    ).toBe(0);
  });

  it('counts a task update builder kept apart from its set', () => {
    const writes = (body: string) =>
      liveWrites('x.ts', `async function f(tx) { ${body} }`).map((w) => w.covered);
    expect(
      writes(`const update = tx.update(schema.tasks); await update.set({ status: 'running' });`),
    ).toEqual([false]);
    expect(
      writes(
        `await ${GUARD}(tx, id); const update = tx.update(schema.tasks); await update.set({ status: 'running' });`,
      ),
    ).toEqual([true]);
  });

  it('counts a local patch that is replaced or assigned into', () => {
    const count = (body: string) =>
      liveWrites(
        'x.ts',
        `async function f(o) { ${body} await db.update(schema.tasks).set(patch); }`,
      ).length;
    expect(count(`let patch = {}; patch = { status: 'running' };`)).toBe(1);
    expect(count(`const patch = {}; Object.assign(patch, o);`)).toBe(1);
    expect(count(`const patch = {}; fillTaskPatch(patch);`)).toBe(1);
    expect(count(`const patch = {}; const alias = patch; alias.status = o;`)).toBe(1);
    expect(count(`const patch = { title: 't' }; log(patch.title);`)).toBe(0);
    expect(count(`const patch = { title: 't' }; ({ status: patch.status } = o);`)).toBe(1);
    expect(count(`const patch = { title: 't' }; [patch['status']] = o;`)).toBe(1);
    expect(count(`const patch = { title: 't' }; delete patch.status;`)).toBe(1);
    expect(count(`const patch = { title: 't', revive() {} }; patch.revive();`)).toBe(1);
    expect(count(`const patch = { title: 't' }; patch['go']();`)).toBe(1);
    expect(count(`const patch = { title: 't' }; const x = { a: patch.status };`)).toBe(0);
    expect(count(`const patch = { title: 't' };`)).toBe(0);
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
