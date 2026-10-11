import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
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
/** The status a write sets: `.update(schema.tasks).set(...)`, or the `set` of an
 *  `.insert(schema.tasks)...onConflictDoUpdate(...)`, which revives the row it collides with. */
function writtenStatus(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const builder =
    callee.name.text === 'set'
      ? 'update'
      : callee.name.text === 'onConflictDoUpdate'
        ? 'insert'
        : null;
  if (builder === null) return null;
  let inner: ts.Expression = callee.expression;
  while (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner)) {
    if (
      ts.isCallExpression(inner) &&
      ts.isPropertyAccessExpression(inner.expression) &&
      inner.expression.name.text === builder
    ) {
      if (!isTasksTable(inner.arguments[0])) return null;
      let arg = call.arguments[0];
      if (!arg) return null;
      if (builder === 'insert') {
        if (!ts.isObjectLiteralExpression(arg)) return UNKNOWN;
        const named = arg.properties.filter((p) => keyOf(p.name) === 'set');
        if (arg.properties.some((p) => ts.isSpreadAssignment(p) || keyOf(p.name) === null)) {
          return UNKNOWN;
        }
        const set = named[named.length - 1];
        if (!set) return null;
        if (!ts.isPropertyAssignment(set)) return UNKNOWN;
        arg = set.initializer;
      }
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
    // A member invoked through the patch, however (call, tag, new), may set status through `this`.
    let callee: ts.Expression = p;
    while (
      ts.isParenthesizedExpression(callee.parent) ||
      ts.isNonNullExpression(callee.parent) ||
      ts.isAsExpression(callee.parent) ||
      ts.isTypeAssertionExpression(callee.parent) ||
      ts.isSatisfiesExpression(callee.parent)
    ) {
      callee = callee.parent;
    }
    const at = callee.parent;
    return (
      ((ts.isCallExpression(at) || ts.isNewExpression(at)) && at.expression === callee) ||
      (ts.isTaggedTemplateExpression(at) && at.tag === callee)
    );
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
    // Only plain values: a spread, an accessor or a function can each set status when touched,
    // however it is invoked (a call, a tagged template, a getter read).
    init.properties.some(
      (p) =>
        !(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) ||
        (ts.isPropertyAssignment(p) &&
          (ts.isFunctionExpression(p.initializer) ||
            ts.isArrowFunction(p.initializer) ||
            ts.isClassExpression(p.initializer))) ||
        keyOf(p.name) === null ||
        keyOf(p.name) === 'status',
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
  const sf = set.getSourceFile();
  if (!pred || shadowsName(sf, 'eq') || shadowsName(sf, 'and')) return false;
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

/** A call whose result runs where it is made: awaited, a statement of its own, or returned from
 *  a function whose own call sites are followed. One kept for later can run after the guard's
 *  transaction has ended. */
function consumedInPlace(c: ts.CallExpression): boolean {
  let at: ts.Node = c;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  const p = at.parent;
  return (
    ts.isAwaitExpression(p) ||
    ts.isExpressionStatement(p) ||
    ts.isReturnStatement(p) ||
    (ts.isArrowFunction(p) && p.body === at)
  );
}

function isDeclarationName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (
    ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === n) ||
    (ts.isPropertyAccessExpression(p) && p.name === n) ||
    ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n)
  );
}

function isExported(fn: ts.FunctionLikeDeclaration): boolean {
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (ts.isFunctionDeclaration(fn)) return exported(fn);
  const decl = fn.parent;
  return ts.isVariableDeclaration(decl) && exported(decl.parent.parent);
}

function nameOf(fn: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/** A guard statement taking the lock in transaction `tx`: the lock must be held by the very
 *  transaction that writes, or the write runs outside it. */
function isGuardStatement(st: ts.Statement, tx: string, task: string): boolean {
  if (!ts.isExpressionStatement(st) || !ts.isAwaitExpression(st.expression)) return false;
  const call = st.expression.expression;
  return (
    ts.isCallExpression(call) &&
    call.expression.getText() === GUARD &&
    call.arguments[0]?.getText() === tx &&
    call.arguments[1]?.getText() === task
  );
}

/** Whether a guard call in `tx` runs on every path to the node: it is a statement earlier in one
 *  of the blocks that hold the node, within the node's scope. */
function dominated(node: ts.Node, scope: ts.Node, tx: string, task: string): boolean {
  for (let child: ts.Node = node, n = node.parent; n && child !== scope; child = n, n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      const i = n.statements.indexOf(child as ts.Statement);
      if (i > 0 && n.statements.slice(0, i).some((st) => isGuardStatement(st, tx, task))) {
        return true;
      }
    }
  }
  return false;
}

/** Guarded on its own path, in the write's own transaction `tx`: the guard dominates it within its
 *  scope, or its scope is a named function every call of which is guarded in turn, with `tx`
 *  followed to the argument a call passes for it when it is a parameter. */
function guarded(
  sf: ts.SourceFile,
  node: ts.Node,
  tx: string | null,
  task: string | null,
  depth = 0,
): boolean {
  if (tx === null || task === null) return false;
  const scope = scopeOf(node);
  if (!scope || reassigns(scope, tx) || redeclares(scope, tx)) return false;
  if (reassigns(scope, task) || redeclares(scope, task)) return false;
  if (dominated(node, scope, tx, task)) return true;
  const name = nameOf(scope);
  // Calls are read in this file only, by name: an export or a second binding of the name hides some.
  if (!name || depth > 3 || isExported(scope) || bindingsOf(sf, name) !== 1) return false;
  const indexOf = (n: string) =>
    scope.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === n);
  const follow = (n: string, c: ts.CallExpression): string | null => {
    const at = indexOf(n);
    if (at < 0) return capturedAlike(scope, c, n) ? n : null;
    const passed = c.arguments[at];
    return passed && ts.isIdentifier(passed) ? passed.text : null;
  };
  const calls: ts.CallExpression[] = [];
  let escaped = false;
  // Every reference must be a direct call: an alias or an argument calls it where no site is read.
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      if (ts.isCallExpression(p) && p.expression === n) calls.push(p);
      else if (!isDeclarationName(n)) escaped = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return (
    !escaped &&
    calls.length > 0 &&
    calls.every(
      (c) => consumedInPlace(c) && guarded(sf, c, follow(tx, c), follow(task, c), depth + 1),
    )
  );
}

/** Whether a name the helper captures means the same binding at a call site: no function between
 *  either of them and the scope they share declares it again. */
function capturedAlike(helper: ts.FunctionLikeDeclaration, call: ts.Node, name: string): boolean {
  const outer = new Set<ts.Node>();
  for (let f = enclosingFunction(helper); f; f = enclosingFunction(f)) outer.add(f);
  let shared: ts.Node | null = null;
  for (let f = enclosingFunction(call); f; f = enclosingFunction(f)) {
    if (outer.has(f)) {
      shared = f;
      break;
    }
    if (declaresDirectly(f, name)) return false;
  }
  for (let f = enclosingFunction(helper); f && f !== shared; f = enclosingFunction(f)) {
    if (declaresDirectly(f, name)) return false;
  }
  return true;
}

function declaresDirectly(fn: ts.FunctionLikeDeclaration, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isBindingElement(n) ||
        ts.isFunctionDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      (ts.isParameter(n) ? n.parent === fn : enclosingFunction(n) === fn)
    ) {
      found = true;
    }
    if (!found && (n === fn || !ts.isFunctionLike(n))) ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/** Whether `name` is assigned anywhere in `scope`: a reassigned handle can lock in one transaction
 *  and write in another under the same name, so it never matches. */
function reassigns(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    // Any target position: plain, compound, destructuring, ++/--, a for-of/for-in head.
    if (ts.isIdentifier(n) && n.text === name && isWriteTarget(n)) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** Whether `name` is declared again inside `scope`, beyond the scope's own parameter: a nested
 *  binding can shadow the handle the guard locked, under the same text. */
function redeclares(scope: ts.FunctionLikeDeclaration, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      n !== scope &&
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      !(ts.isParameter(n) && n.parent === scope)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** Whether `name` (the guard, or a Drizzle helper the scan reads by name) is bound in this file by
 *  anything but its import or its own exported definition, which would let another function pass for
 *  it. */
function shadowsName(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    const named = (n as { name?: ts.Node }).name;
    if (
      named &&
      ts.isIdentifier(named) &&
      named.text === name &&
      (ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isBindingElement(n) ||
        ts.isClassDeclaration(n)) &&
      !(
        ts.isFunctionDeclaration(n) &&
        ts.isSourceFile(n.parent) &&
        name === GUARD &&
        sf.fileName === 'routes/upgrades.ts' &&
        n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
    ) {
      found = true;
    }
    if (
      (ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)) &&
      n.name?.text === name &&
      !importsFromOwnModule(sf, n, name)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// The module each name the scan reads must come from, relative to the sources it checks.
const OWN_MODULE: Record<string, (from: string) => boolean> = {
  [GUARD]: (from) => from === 'routes/upgrades.js',
  eq: (from) => from === 'drizzle-orm',
  and: (from) => from === 'drizzle-orm',
};

function importsFromOwnModule(sf: ts.SourceFile, n: ts.Node, name: string): boolean {
  if (!ts.isImportSpecifier(n) || (n.propertyName ?? n.name).text !== name) return false;
  const spec = (n.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text;
  const from = spec.startsWith('.') ? posix.join(posix.dirname(sf.fileName), spec) : spec;
  return OWN_MODULE[name]?.(from) ?? false;
}

/** The task a write revives: the identifier `X` of `eq(schema.tasks.id, X)` in the `.where(...)`
 *  after its `.set(...)`. Read through `and(...)`, a conditional whose branches agree, and a helper
 *  in the same file that returns such a predicate for one of its parameters. */
function writeTask(set: ts.CallExpression): string | null {
  const access = set.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'where') return null;
  const where = access.parent;
  if (!ts.isCallExpression(where)) return null;
  const sf = set.getSourceFile();
  if (!where.arguments[0] || shadowsName(sf, 'eq') || shadowsName(sf, 'and')) return null;
  return taskOfPredicate(sf, where.arguments[0], 0);
}

function taskOfPredicate(sf: ts.SourceFile, e: ts.Expression, depth: number): string | null {
  if (ts.isParenthesizedExpression(e)) return taskOfPredicate(sf, e.expression, depth);
  if (ts.isConditionalExpression(e)) {
    const a = taskOfPredicate(sf, e.whenTrue, depth);
    return a !== null && a === taskOfPredicate(sf, e.whenFalse, depth) ? a : null;
  }
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
  const callee = e.expression.text;
  if (callee === 'eq') {
    const id = e.arguments[1];
    return isTasksIdColumn(e.arguments[0]) && id && ts.isIdentifier(id) ? id.text : null;
  }
  if (callee === 'and') {
    for (const a of e.arguments) {
      const hit = taskOfPredicate(sf, a, depth);
      if (hit) return hit;
    }
    return null;
  }
  if (depth > 2) return null;
  const helper = sf.statements.find(
    (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === callee,
  );
  const body = helper?.body?.statements;
  if (!helper || body?.length !== 1 || !ts.isReturnStatement(body[0]!) || !body[0].expression) {
    return null;
  }
  // Only the top-level declaration may bind the name: a local one would shadow it at the call.
  if (bindingsOf(sf, callee) !== 1 || reassigns(sf, callee)) return null;
  const inner = taskOfPredicate(sf, body[0].expression, depth + 1);
  const at = helper.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === inner);
  const passed = at < 0 ? undefined : e.arguments[at];
  return passed && ts.isIdentifier(passed) ? passed.text : null;
}

/** How many declarations in the file bind `name`. */
function bindingsOf(sf: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (n: ts.Node): void => {
    const named = (n as { name?: ts.Node }).name;
    if (
      named &&
      ts.isIdentifier(named) &&
      named.text === name &&
      (ts.isVariableDeclaration(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isBindingElement(n) ||
        ts.isClassDeclaration(n) ||
        ts.isImportSpecifier(n))
    ) {
      count += 1;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

function isTasksIdColumn(n: ts.Node | undefined): boolean {
  return (
    n !== undefined &&
    ts.isPropertyAccessExpression(n) &&
    isTasksTable(n.expression) &&
    n.name.text === 'id'
  );
}

/** The transaction a write runs in: the identifier its builder chain starts at, if it is one. */
function writeTx(call: ts.CallExpression): string | null {
  const root = chainRoot(call.expression);
  return ts.isIdentifier(root) ? root.text : null;
}

/** Every live-status write on a task row in one source, with whether it is covered. */
/** A `.update(schema.tasks)` not chained straight into `.set(...)`, or a task builder chain kept
 *  in a variable: whatever later sets its status, or runs it outside the guarded transaction, is
 *  out of sight, so the builder itself is the write. */
function detachedTaskBuilder(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression) || !isTasksTable(call.arguments[0])) {
    return false;
  }
  if (call.expression.name.text === 'update') {
    const set = call.parent;
    if (!(
      ts.isPropertyAccessExpression(set) &&
      set.name.text === 'set' &&
      ts.isCallExpression(set.parent) &&
      set.parent.expression === set
    )) {
      return true;
    }
  } else if (call.expression.name.text !== 'insert') return false;
  let top: ts.Node = call;
  while (
    (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent)) &&
    top.parent.expression === top
  ) {
    top = top.parent;
  }
  const at = top.parent;
  if (ts.isAwaitExpression(at) || ts.isExpressionStatement(at)) return false;
  // Returned from a function: its call sites are where it runs, and they are followed in turn.
  if (call.expression.name.text === 'update') {
    return !(ts.isReturnStatement(at) || (ts.isArrowFunction(at) && at.body === top));
  }
  return true;
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
          covered:
            movesOnlyCreated(node) ||
            (!shadowsName(sf, GUARD) && guarded(sf, node, writeTx(node), writeTask(node))),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every place in a source that reaches the tasks table other than as the text `schema.tasks`. */
function tasksAliases(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      tasksTableEscapes(n) ||
      (ts.isImportDeclaration(n) && importRenamesTasks(n)) ||
      (ts.isExportDeclaration(n) && reexportsTasks(n)) ||
      importsDatabaseDynamically(n) ||
      schemaEscapes(n) ||
      writesTasksAsText(n)
    ) {
      out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const QUERY_BUILDERS = new Set(['update', 'from', 'insert', 'delete', 'innerJoin', 'leftJoin']);
// The names the database handle goes by in the sources; a builder on anything else is a helper.
const DB_HANDLES = new Set(['db', 'tx', 'getDb', 'handle']);

function chainRoot(n: ts.Expression): ts.Expression {
  while (ts.isCallExpression(n) || ts.isPropertyAccessExpression(n)) n = n.expression;
  return n;
}

/** `schema.tasks` read off the AST, so comments or spacing inside it do not hide it. */
function isTasksTable(n: ts.Node | undefined): n is ts.PropertyAccessExpression {
  return (
    n !== undefined &&
    ts.isPropertyAccessExpression(n) &&
    n.questionDotToken === undefined &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'schema' &&
    n.name.text === 'tasks'
  );
}

/** `schema.tasks` used whole other than as a query builder's table or in a raw `sql` read: an
 *  alias, an argument or a return carries it to a write the scan does not read. */
function tasksTableEscapes(n: ts.Node): boolean {
  if (!isTasksTable(n)) return false;
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return false;
  if (ts.isTemplateSpan(p) && ts.isTaggedTemplateExpression(p.parent.parent)) {
    const tagged = p.parent.parent;
    return !isSqlTag(tagged.tag) || /\bupdate\b/i.test(tagged.template.getText());
  }
  if (
    !ts.isCallExpression(p) ||
    p.arguments[0] !== n ||
    !ts.isPropertyAccessExpression(p.expression) ||
    !QUERY_BUILDERS.has(p.expression.name.text)
  ) {
    return true;
  }
  const root = chainRoot(p.expression.expression);
  return !(ts.isIdentifier(root) && DB_HANDLES.has(root.text));
}

/** `schema` used other than as plain `schema.<table>` (no `?.`, `!` or parentheses): an alias, a
 *  destructure, a computed key or an argument can each reach the tasks table unread. */
function schemaEscapes(n: ts.Node): boolean {
  if (!ts.isIdentifier(n) || n.text !== 'schema') return false;
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p)) return p.questionDotToken !== undefined;
  if (ts.isImportSpecifier(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p)) return false;
  if (ts.isExportSpecifier(p) && p.parent.parent.moduleSpecifier) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name === n) return false;
  return true;
}

// Table-name constants a raw mutation may target, none of them tasks: `@haive/shared/rag`'s `ai_rag_embeddings`.
const NON_TASK_TABLES = new Set(['RAG_TABLE']);

/** The expression substituted right after a template fragment, if there is one. */
function nextSubstitution(n: ts.Node): ts.Expression | null {
  const owner = ts.isTemplateHead(n) ? n.parent : ts.isTemplateMiddle(n) ? n.parent.parent : null;
  if (!owner || !ts.isTemplateExpression(owner)) return null;
  const at = ts.isTemplateHead(n) ? 0 : owner.templateSpans.findIndex((sp) => sp.literal === n) + 1;
  return owner.templateSpans[at]?.expression ?? null;
}

function importsDrizzleAs(sf: ts.SourceFile, name: string): boolean {
  return sf.statements.some(
    (st) =>
      ts.isImportDeclaration(st) &&
      (st.moduleSpecifier as ts.StringLiteral).text === 'drizzle-orm' &&
      st.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(st.importClause.namedBindings) &&
      st.importClause.namedBindings.name.text === name,
  );
}

/** Drizzle's `sql` tag, under its own name, an import's alias, or a namespace import. */
function isSqlTag(tag: ts.Expression): boolean {
  if (
    ts.isPropertyAccessExpression(tag) &&
    tag.name.text === 'sql' &&
    ts.isIdentifier(tag.expression)
  ) {
    return importsDrizzleAs(tag.getSourceFile(), tag.expression.text);
  }
  if (!ts.isIdentifier(tag)) return false;
  if (tag.text === 'sql') return true;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isImportSpecifier(n) &&
      n.name.text === tag.text &&
      (n.propertyName ?? n.name).text === 'sql'
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(tag.getSourceFile());
  return found;
}

const RAW_SQL_CALLS = new Set(['raw', 'execute', 'unsafe', 'query']);

/** Text that reaches a query: a `sql` template, or an argument of a raw-SQL call, through
 *  concatenation, parentheses and template substitutions. */
function inSqlContext(n: ts.Node): boolean {
  let at: ts.Node = n;
  for (;;) {
    const p = at.parent;
    if (!p) return false;
    if (ts.isTaggedTemplateExpression(p)) return isSqlTag(p.tag);
    if (ts.isCallExpression(p)) {
      return (
        p.arguments.includes(at as ts.Expression) &&
        ts.isPropertyAccessExpression(p.expression) &&
        RAW_SQL_CALLS.has(p.expression.name.text)
      );
    }
    const passes =
      (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isParenthesizedExpression(p) ||
      ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p);
    if (!passes) return false;
    at = p;
  }
}

const TASK_TABLE = String.raw`(only\s+)?("?\w+"?\s*\.\s*)?"?tasks"?`;
// Shaped as a statement, not just named: "Update tasks before retrying" has no SET.
const TASK_MUTATION = new RegExp(
  [
    String.raw`\bupdate\s+${TASK_TABLE}(\s+(as\s+)?\w+)?\s+set\b`,
    String.raw`\binsert\s+into\s+${TASK_TABLE}\s*(\(|values\b|select\b|default\b|overriding\b)`,
    String.raw`\bdelete\s+from\s+${TASK_TABLE}([^\w$-]|$)`,
    String.raw`\bmerge\s+into\s+${TASK_TABLE}\b[\s\S]*\busing\b`,
    String.raw`\btruncate\s+(table\s+)?${TASK_TABLE}([^\w$-]|$)`,
    String.raw`\bcopy\s+${TASK_TABLE}\s*(\(|from\b)`,
  ].join('|'),
  'i',
);
const DANGLING_TARGET =
  /\b(update|insert\s+into|merge\s+into|delete\s+from|truncate(\s+table)?)\s+(only\s+)?("?\w+"?\s*\.\s*)?$/i;

/** Text holding a mutating statement on the tasks table, wherever it flows (a raw `sql` UPDATE,
 *  a constant run later): no builder is there to read. Comments are dropped. */
function writesTasksAsText(n: ts.Node): boolean {
  if (!ts.isStringLiteralLike(n) && !ts.isTemplateLiteralToken(n)) return false;
  const text = n.text.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ');
  if (TASK_MUTATION.test(text)) return true;
  // A fragment ending at a mutation's target names it elsewhere (a concatenation, a raw chunk).
  if (!DANGLING_TARGET.test(text) || !inSqlContext(n)) return false;
  const target = nextSubstitution(n);
  return !(
    target &&
    (isTasksTable(target) || (ts.isIdentifier(target) && NON_TASK_TABLES.has(target.text)))
  );
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

/** `import('@haive/database…')`: what it resolves to reaches the tasks table under any name. */
function importsDatabaseDynamically(n: ts.Node): boolean {
  if (!ts.isCallExpression(n) || n.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
  const from = n.arguments[0];
  return !from || !ts.isStringLiteralLike(from) || from.text.startsWith('@haive/database');
}

/** A re-export from the database package that hands the tasks table to another module, whose
 *  importers the scan would read under a name it does not know. */
function reexportsTasks(decl: ts.ExportDeclaration): boolean {
  const from = decl.moduleSpecifier;
  if (!from || !ts.isStringLiteral(from) || !from.text.startsWith('@haive/database')) return false;
  const clause = decl.exportClause;
  if (!clause || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((e) => ['tasks', 'schema'].includes((e.propertyName ?? e.name).text));
}

// A write that puts a task row back to a live status revives it, so it must run the revival's
// exclusion on its own path, unless it only starts a task that was never live.
// It reads code written in good faith: a write disguised on purpose (a split SQL keyword, a fake
// database handle) is review's to catch, since closing every such form takes an interpreter.
describe('a live-status write on a task row', () => {
  it(`calls ${GUARD} on its own path, or moves only a created task`, () => {
    const writes = sources(SRC).flatMap((f) =>
      liveWrites(relative(SRC, f), readFileSync(f, 'utf8')),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((w) => !w.covered)).toEqual([]);
  }, 30_000);

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
        `queueMicrotask(async () => { await ${GUARD}(tx, id); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id)); });`,
      ),
    ).toEqual([true]);
  });

  it('checks a named function inside a transaction at its call sites', () => {
    const covered = (body: string) =>
      liveWrites(
        'x.ts',
        `async function route() { await db.transaction(async (tx) => { ${body} function run() { return tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id)); } }); }`,
      ).map((w) => w.covered);
    expect(covered(`await run(); await ${GUARD}(tx, id);`)).toEqual([false]);
    expect(covered(`await ${GUARD}(tx, id); await run();`)).toEqual([true]);
  });

  // Every check here reads a task-row write by its `schema.tasks` text, so nothing may rename it.
  it('finds schema.tasks under no other name in the sources it checks', () => {
    const aliases = sources(SRC).flatMap((f) =>
      tasksAliases(relative(SRC, f), readFileSync(f, 'utf8')),
    );
    expect(aliases).toEqual([]);
  }, 30_000);

  it('reads every other way to reach the tasks table as an alias', () => {
    const found = (text: string) => tasksAliases('x.ts', text).length;
    expect(found(`const t = schema.tasks;`)).toBe(1);
    expect(
      found("await db.execute(sql`UPDATE tasks SET status = 'running' WHERE id = ${id}`);"),
    ).toBe(1);
    expect(found('await db.execute(sql.raw(\'update "public"."tasks" set status = 1\'));')).toBe(1);
    expect(found('await db.execute(sql`INSERT INTO tasks (id) VALUES (${id})`);')).toBe(1);
    expect(found("await db.execute(sql`UPDATE task_steps SET status = 'done'`);")).toBe(0);
    expect(found("sql`UPDATE /* retry */ tasks SET status = 'running'`")).toBe(1);
    expect(
      found(
        "sql`MERGE INTO public.tasks t USING x ON true WHEN MATCHED THEN UPDATE SET status = 'running'`",
      ),
    ).toBe(1);
    expect(found("const m = 'Cancel them first, or delete the tasks.';")).toBe(0);
    expect(found("throw new HttpError(409, 'Update tasks before retrying');")).toBe(0);
    expect(found(`let q; q = "UPDATE tasks SET status = 'running'"; await tx.unsafe(q);`)).toBe(1);
    expect(
      found("import * as orm from 'drizzle-orm'; orm.sql`UPDATE ${table} SET status = 1`;"),
    ).toBe(1);
    expect(found(`export const reviveTask = "UPDATE tasks SET status = 'running'";`)).toBe(1);
    expect(
      found(
        "import { sql as statement } from 'drizzle-orm'; statement`UPDATE tasks SET status = 1`;",
      ),
    ).toBe(1);
    expect(found(`const q = "UPDATE tasks SET status = 'running'"; await tx.unsafe(q);`)).toBe(1);
    expect(found(`const q = 'Update tasks before retrying'; throw new HttpError(409, q);`)).toBe(0);
    expect(found("await tx.unsafe(`UPDATE tasks SET status = 'running'`);")).toBe(1);
    expect(found("sql.raw('UPDATE ' + 'tasks SET status = 1')")).toBe(1);
    expect(found("sql`UPDATE ${sql.raw('tasks')} SET status = 'running'`")).toBe(1);
    expect(found(`let t; t = schema.tasks;`)).toBe(1);
    expect(found(`const { tasks } = schema;`)).toBe(1);
    expect(
      found(
        `db.update(schema['tasks']).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toBe(1);
    expect(found(`const tables = schema; db.update(tables.tasks).set({ status: 'x' });`)).toBe(1);
    expect(found(`let tables; tables = schema;`)).toBe(1);
    expect(found(`write({ schema });`)).toBe(1);
    expect(found(`revive(schema.tasks);`)).toBe(1);
    expect(found(`return schema.tasks;`)).toBe(1);
    expect(found(`const t = helper.from(schema.tasks); db.update(t).set({ status: 'x' });`)).toBe(
      1,
    );
    expect(found(`await getDb().select().from(schema.tasks).innerJoin(schema.tasks, x);`)).toBe(0);
    expect(
      found(`db.update(schema?.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`),
    ).toBe(1);
    expect(
      found(`db.update(schema!.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`),
    ).toBe(1);
    expect(
      found(`db.update((schema).tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`),
    ).toBe(1);
    expect(found('db.execute(sql`update ${schema.tasks} set status = 1`);')).toBe(1);
    expect(found('const from = sql`from ${schema.tasks} t`;')).toBe(0);
    expect(found(`db.select().from(schema.tasks).where(eq(schema.tasks.id, id));`)).toBe(0);
    expect(found(`type T = typeof schema; const x = { schema: 1 };`)).toBe(0);
    expect(
      found(`db.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`),
    ).toBe(0);
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

  it('reads a re-export that hands the tasks table on as an alias', () => {
    const found = (text: string) => tasksAliases('x.ts', text).length;
    expect(found(`export { tasks } from '@haive/database/schema';`)).toBe(1);
    expect(found(`export { schema as s } from '@haive/database';`)).toBe(1);
    expect(found(`export * from '@haive/database/schema';`)).toBe(1);
    expect(found(`export * as db from '@haive/database';`)).toBe(1);
    expect(found(`export { schema };`)).toBe(1);
    expect(found(`export { users } from '@haive/database/schema';`)).toBe(0);
    expect(found(`const { tasks } = await import('@haive/database/schema');`)).toBe(1);
    expect(found(`const m = await import(name);`)).toBe(1);
    expect(found(`const z = await import('zod');`)).toBe(0);
  });

  it('reads the tasks table through a comment or spacing inside schema.tasks', () => {
    for (const table of ['schema /* row */.tasks', 'schema\n  .tasks']) {
      const src = `async function route() {
        await db.transaction(async (tx) => {
          await tx.update(${table}).set({ status: 'running' }).where(eq(schema.tasks.id, id));
        });
      }`;
      expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
      expect(tasksAliases('x.ts', `revive(${table});`)).toHaveLength(1);
    }
  });

  it('does not count a guard taken in another transaction than the write', () => {
    const covered = (body: string) =>
      liveWrites('x.ts', `async function f(tx, lockTx, id) { ${body} }`).map((w) => w.covered);
    expect(
      covered(
        `await ${GUARD}(lockTx, id); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([false]);
    expect(
      covered(
        `await ${GUARD}(tx, id); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([true]);
    expect(
      covered(
        `let h = lockTx; await ${GUARD}(h, id); h = tx; await h.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([false]);
    expect(
      covered(
        `await ${GUARD}(tx, id); { const tx = lockTx; await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id)); }`,
      ),
    ).toEqual([false]);
    expect(
      covered(
        `await ${GUARD}(tx, id); [tx] = [lockTx]; await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([false]);
    expect(
      covered(
        `await ${GUARD}(tx, id); for (tx of [lockTx]) await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([false]);
    expect(
      liveWrites(
        'x.ts',
        `async function f(tx, id) { const ${GUARD} = async () => {}; await ${GUARD}(tx, id); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id)); }`,
      ).map((w) => w.covered),
    ).toEqual([false]);
  });

  it('does not count a guard for another task than the one the write revives', () => {
    const covered = (body: string) =>
      liveWrites('x.ts', `async function f(tx, id, otherId) { ${body} }`).map((w) => w.covered);
    expect(
      covered(
        `await ${GUARD}(tx, otherId); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([false]);
    expect(
      covered(
        `await ${GUARD}(tx, id); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([true]);
  });

  it('reads no task through a predicate helper a local binding shadows', () => {
    const src = `function byId(taskId) { return eq(schema.tasks.id, taskId); }
      async function f(tx, id, otherId) {
        const byId = () => eq(schema.tasks.id, otherId);
        await ${GUARD}(tx, id);
        await tx.update(schema.tasks).set({ status: 'running' }).where(byId(id));
      }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('exempts no created-only predicate when eq or and is shadowed', () => {
    const covered = (body: string) =>
      liveWrites('x.ts', `async function f(tx, id, eq) { ${body} }`).map((w) => w.covered);
    expect(
      covered(
        `await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.status, 'created'));`,
      ),
    ).toEqual([false]);
  });

  it('counts the guard and the Drizzle helpers only from their own modules', () => {
    const write = `await ${GUARD}(tx, id); await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`;
    const covered = (imports: string, file = 'routes/tasks/x.ts') =>
      liveWrites(file, `${imports} async function f(tx, id) { ${write} }`).map((w) => w.covered);
    const drizzle = `import { eq } from 'drizzle-orm';`;
    expect(covered(`import { ${GUARD} } from '../upgrades.js'; ${drizzle}`)).toEqual([true]);
    expect(covered(`import { ${GUARD} } from './upgrades.js'; ${drizzle}`, 'routes/x.ts')).toEqual([
      true,
    ]);
    expect(covered(`import { ${GUARD} } from './noop.js'; ${drizzle}`)).toEqual([false]);
    expect(covered(`import { other as ${GUARD} } from '../upgrades.js'; ${drizzle}`)).toEqual([
      false,
    ]);
    expect(covered(`import ${GUARD} from '../upgrades.js'; ${drizzle}`)).toEqual([false]);
    expect(
      covered(`import { ${GUARD} } from '../upgrades.js'; import { eq } from './eq.js';`),
    ).toEqual([false]);
  });

  it('counts an exported guard only as the real definition in routes/upgrades.ts', () => {
    const src = `export async function ${GUARD}() {}
      async function f(tx, id) {
        await ${GUARD}(tx, id);
        await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      }`;
    expect(liveWrites('routes/tasks/x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('reads a task update whose set is invoked through a wrapper as a write', () => {
    const covered = (body: string) =>
      liveWrites('x.ts', `async function f(db, id) { ${body} }`).map((w) => w.covered);
    expect(covered(`await db.update(schema.tasks).set!({ status: 'running' });`)).toEqual([false]);
    expect(covered(`await (db.update(schema.tasks).set)({ status: 'running' });`)).toEqual([false]);
  });

  it('covers a named write helper only when its calls are all in sight', () => {
    const write = `await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));`;
    const shadowed = `async function revive(tx, id) { ${write} }
      async function route(tx, id) {
        function revive(...args) {}
        await ${GUARD}(tx, id);
        await revive(tx, id);
      }`;
    expect(liveWrites('x.ts', shadowed).map((w) => w.covered)).toEqual([false]);
    const exported = `export async function revive(tx, id) { ${write} }
      async function route(tx, id) { await ${GUARD}(tx, id); await revive(tx, id); }`;
    expect(liveWrites('x.ts', exported).map((w) => w.covered)).toEqual([false]);
  });

  it('reads a task update chain stored for later as an unguarded write', () => {
    const src = `async function route(id) {
        let later;
        await db.transaction(async (tx) => {
          await ${GUARD}(tx, id);
          later = tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
        });
        await later;
      }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toContain(false);
  });

  it('does not cover a helper whose result is kept past the guarded transaction', () => {
    const src = `function make(tx, id) {
        return tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      }
      async function route(id) {
        let later;
        await db.transaction(async (tx) => { await ${GUARD}(tx, id); later = make(tx, id); });
        await later;
      }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
  });

  it('does not let a call site rebind what a helper captures', () => {
    const src = `async function route(tx, id) {
        async function revive() {
          await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
        }
        async function other(tx, id) {
          await ${GUARD}(tx, id);
          await revive();
        }
        await other(tx2, id2);
      }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
    const same = `async function route(tx, id) {
        async function revive() {
          await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
        }
        await ${GUARD}(tx, id);
        await revive();
      }`;
    expect(liveWrites('x.ts', same).map((w) => w.covered)).toEqual([true]);
  });

  it('does not cover a named write helper that escapes under another name', () => {
    const src = `async function revive(tx, id) {
        await tx.update(schema.tasks).set({ status: 'running' }).where(eq(schema.tasks.id, id));
      }
      async function route(tx, id) {
        const alias = revive;
        await ${GUARD}(tx, id);
        await revive(tx, id);
        await alias(tx, id);
      }`;
    expect(liveWrites('x.ts', src).map((w) => w.covered)).toEqual([false]);
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
      writes(
        `const update = tx.update(schema.tasks); await update.set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
    ).toEqual([false]);
    expect(
      writes(
        `await ${GUARD}(tx, id); const update = tx.update(schema.tasks); await update.set({ status: 'running' }).where(eq(schema.tasks.id, id));`,
      ),
      // Which row a detached builder revives is out of sight, so no guard can be matched to it.
    ).toEqual([false]);
  });

  it('counts an upsert that sets a live status on the row it collides with', () => {
    const count = (body: string) =>
      liveWrites(
        'x.ts',
        `async function f(v, s) { await db.insert(schema.tasks).values(v)${body}; }`,
      ).length;
    expect(
      count(`.onConflictDoUpdate({ target: schema.tasks.id, set: { status: 'queued' } })`),
    ).toBe(1);
    expect(count(`.onConflictDoUpdate({ target: schema.tasks.id, set: s })`)).toBe(1);
    expect(count(`.onConflictDoUpdate({ target: schema.tasks.id, set: { title: 't' } })`)).toBe(0);
    expect(count(`.onConflictDoNothing()`)).toBe(0);
  });

  it('counts a task insert kept in a variable, whose conflict update is out of sight', () => {
    const count = (body: string) => liveWrites('x.ts', `async function f(v) { ${body} }`).length;
    expect(
      count(
        `const q = db.insert(schema.tasks).values(v); await q.onConflictDoUpdate({ target: schema.tasks.id, set: { status: 'queued' } });`,
      ),
    ).toBe(1);
    expect(count(`const rows = await db.insert(schema.tasks).values(v).returning();`)).toBe(0);
    expect(count(`await applyUpsert(db.insert(schema.tasks).values(v));`)).toBe(1);
    expect(count(`return db.insert(schema.tasks).values(v);`)).toBe(1);
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
    expect(count(`const patch = { title: 't', revive }; patch.revive!();`)).toBe(1);
    expect(count(`const patch = { title: 't', revive }; (patch.revive as any)();`)).toBe(1);
    expect(
      count(`function tag() { this.status = 'running'; } const patch = { tag }; patch.tag\`\`;`),
    ).toBe(1);
    expect(
      count(`const patch = { tag: function () { this.status = 'running'; } }; patch.tag\`\`;`),
    ).toBe(1);
    expect(
      count(`const patch = { title: 't', get p() { this.status = 'running'; } }; patch.p;`),
    ).toBe(1);
    expect(count(`const patch = { title: 't', set p(v) { this.status = v; } }; patch.p = 1;`)).toBe(
      1,
    );
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
