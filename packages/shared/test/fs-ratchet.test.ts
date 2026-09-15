import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// `../src/fs-safe.ts` replaces path-based `node:fs` calls on repository paths one PR at a time, and
// nothing else stops a new one landing meanwhile (there is no ESLint). This pins the count per
// source file: a conversion lowers its entry, a new call raises it where a reviewer sees it. Exact
// counts, so the baseline cannot drift stale in either direction.
//
// Calls are resolved on the TypeScript AST with the binder, not by text: a regex cannot tell
// `const rm = runner.remove()` (a local shadowing the import, which the tree has) from
// `const f = rm` (an alias it must refuse), and the binder answers that per identifier.
//
// Refresh after a conversion:  UPDATE_FS_RATCHET=1 pnpm --filter @haive/shared test

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE = path.join(HERE, 'fs-ratchet.json');
const SCAN_ROOTS = ['packages/api/src', 'packages/worker/src', 'packages/shared/src/repo'];

/** Every path-taking export of `node:fs` / `node:fs/promises` on Node 26.7.0 (checked against
 *  the runtime's own export list: what is absent here is descriptor-based — `fstat`, `ftruncate`,
 *  `read`, `write`, … — or takes no path). Sync twins follow from the suffix rule below. */
const CALLS = new Set([
  'readFile',
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rmdir',
  'unlink',
  'rename',
  'copyFile',
  'cp',
  'chmod',
  'chown',
  'stat',
  'access',
  'exists',
  'readdir',
  'opendir',
  'open',
  'truncate',
  'createReadStream',
  'createWriteStream',
  'realpath',
  'lstat',
  'readlink',
  'symlink',
  'link',
  'lchown',
  'lchmod',
  'utimes',
  'lutimes',
  'mkdtemp',
  'mkdtempDisposable',
  'watch',
  'watchFile',
  'unwatchFile',
  'statfs',
  'glob',
  'openAsBlob',
  // The two exported stream classes take a path when constructed directly.
  'ReadStream',
  'WriteStream',
]);
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
/** Cheap pre-filter: a file that never names the module, and never names a CJS route that
 *  could reach it without naming it at the import site, binds nothing from it. */
const MENTIONS_FS = /['"](?:node:)?fs(?:\/promises)?['"]|createRequire|getBuiltinModule/;

/** One of the path-taking fs functions, in its async or its sync form. */
function isPathCall(name: string): boolean {
  return CALLS.has(name) || (name.endsWith('Sync') && CALLS.has(name.slice(0, -4)));
}

/** `namespace`: the whole module under a name (`* as fs`, a default import, `{ promises as
 *  fsp }`, `{ default as fs }`, `const fs = await import(...)`). `function`: one path-taking
 *  function under a local name, aliased or not. Anything else imported from the module — a type,
 *  `constants`, a descriptor-based call — binds nothing this counts. */
type Binding = 'namespace' | 'function';

/** `import('node:fs')`, `require('node:fs')` or `module.require('node:fs')`: a call that loads
 *  the module (the CommonJS forms matter for the `.cts` sources the scan includes). */
function isFsLoadCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const loads =
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === 'require') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require');
  const arg = node.arguments[0];
  return loads && arg !== undefined && ts.isStringLiteral(arg) && FS_MODULE.test(arg.text);
}

function isDynamicImport(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function isFsImportDeclaration(node: ts.Node): node is ts.ImportDeclaration {
  return (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    FS_MODULE.test(node.moduleSpecifier.text)
  );
}

/** `await import('node:fs')` or `require('node:fs')`, parenthesised or not, with any `.default`
 *  / `.promises` after it: an expression that IS the module, and so may initialise a namespace
 *  binding. A bare `import()` without `await` is a promise, not the module, and stays out. */
function isModuleExpression(node: ts.Expression): boolean {
  if (isFsLoadCall(node)) return !isDynamicImport(node);
  if (ts.isAwaitExpression(node)) {
    return isFsLoadCall(node.expression) && isDynamicImport(node.expression);
  }
  if (ts.isParenthesizedExpression(node)) return isModuleExpression(node.expression);
  if (ts.isPropertyAccessExpression(node) && ['default', 'promises'].includes(node.name.text)) {
    return isModuleExpression(node.expression);
  }
  return false;
}

function bindingForImported(imported: string): Binding | null {
  if (imported === 'default' || imported === 'promises') return 'namespace';
  return isPathCall(imported) ? 'function' : null;
}

/** `import type …`: `isTypeOnly` before TypeScript 5.9, `phaseModifier` from it on. */
function isTypeOnlyClause(clause: ts.ImportClause): boolean {
  const c = clause as { isTypeOnly?: boolean; phaseModifier?: number };
  return c.isTypeOnly === true || c.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

/** What the declaration a symbol resolves to binds from the fs module, if anything. `unknown`
 *  is a destructuring the walk cannot read (a computed or array pattern), which is refused. */
function bindingOf(symbol: ts.Symbol | undefined): Binding | 'unknown' | null {
  const decl = symbol?.declarations?.[0];
  if (!decl) return null;
  if (ts.isNamespaceImport(decl)) {
    return isFsImportDeclaration(decl.parent.parent) ? 'namespace' : null;
  }
  if (ts.isImportClause(decl)) {
    return isFsImportDeclaration(decl.parent) && !isTypeOnlyClause(decl) ? 'namespace' : null;
  }
  if (ts.isImportEqualsDeclaration(decl)) {
    // `import fs = require('node:fs')`
    const ref = decl.moduleReference;
    const external =
      ts.isExternalModuleReference(ref) &&
      ts.isStringLiteral(ref.expression) &&
      FS_MODULE.test(ref.expression.text);
    return external && !decl.isTypeOnly ? 'namespace' : null;
  }
  if (ts.isImportSpecifier(decl)) {
    const clause = decl.parent.parent;
    if (!isFsImportDeclaration(clause.parent) || decl.isTypeOnly || isTypeOnlyClause(clause)) {
      return null;
    }
    return bindingForImported((decl.propertyName ?? decl.name).text);
  }
  if (ts.isVariableDeclaration(decl)) {
    return decl.initializer && ts.isIdentifier(decl.name) && isModuleExpression(decl.initializer)
      ? 'namespace'
      : null;
  }
  if (ts.isBindingElement(decl)) {
    // Climb nested patterns (`const { promises: { readFile } } = await import(...)`) to the
    // declaration, collecting the keys on the way down from the module.
    // Readability (identifier keys, object patterns only) is judged only once the owning
    // declaration is known to hold the module — any other destructuring binds nothing here.
    const keys: string[] = [];
    let readable = true;
    // `{ ...rest }` at the leaf is the module (or the member above it) minus a few keys.
    const rest = decl.dotDotDotToken !== undefined;
    let node: ts.Node = decl;
    while (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      if (node === decl && rest) {
        if (!ts.isObjectBindingPattern(node.parent)) readable = false;
      } else if (ts.isIdentifier(key) && ts.isObjectBindingPattern(node.parent)) {
        keys.unshift(key.text);
      } else {
        readable = false;
      }
      node = node.parent.parent;
    }
    if (!ts.isVariableDeclaration(node) || !node.initializer) return null;
    if (!isModuleExpression(node.initializer)) return null;
    if (!readable) return 'unknown';
    if (rest) {
      while (keys.length > 0 && (keys[0] === 'promises' || keys[0] === 'default')) keys.shift();
      return keys.length === 0 ? 'namespace' : null;
    }
    while (keys.length > 1 && (keys[0] === 'promises' || keys[0] === 'default')) keys.shift();
    return keys.length === 1 ? bindingForImported(keys[0]!) : null;
  }
  return null;
}

/** The property chain hanging off `expr` (`fs.promises.readFile` → `['promises', 'readFile']`)
 *  and the outermost expression, whose parent says whether the chain is called. */
function chainFrom(expr: ts.Expression): { names: string[]; top: ts.Expression } {
  let top = expr;
  const names: string[] = [];
  for (;;) {
    const parent = top.parent;
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== top) break;
    top = parent;
    names.push(parent.name.text);
  }
  return { names, top };
}

/** Called, or constructed (`new fs.ReadStream(path)`). */
function isCallee(expr: ts.Expression): boolean {
  const p = expr.parent;
  return (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === expr;
}

/** `x instanceof fs.ReadStream` reads the class without touching a path. */
function isInstanceofTarget(expr: ts.Expression): boolean {
  const p = expr.parent;
  return (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    p.right === expr
  );
}

/** `call`: a counted path-based call. `ignore`: a member that takes no path (`fs.constants`).
 *  `value`: the function or the module used as a value — passed, assigned, indexed — which is a
 *  rebinding this counter cannot follow, so the file is refused rather than counted low. */
function classifyUse(expr: ts.Expression, kind: Binding): 'call' | 'ignore' | 'value' {
  const { names, top } = chainFrom(expr);
  if (isInstanceofTarget(top)) return 'ignore';
  if (kind === 'function') {
    // `readFile(` or `realpath.native(`
    const plain = names.length === 0 || (names.length === 1 && names[0] === 'native');
    return plain && isCallee(top) ? 'call' : 'value';
  }
  const rest = [...names];
  while (rest.length > 0 && (rest[0] === 'promises' || rest[0] === 'default')) rest.shift();
  const head = rest[0];
  if (head === undefined) return 'value';
  if (!isPathCall(head)) return 'ignore';
  const plain = rest.length === 1 || (rest.length === 2 && rest[1] === 'native');
  return plain && isCallee(top) ? 'call' : 'value';
}

/** True when the identifier is a declaration's own name or a property name — a site that never
 *  reads the binding. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  if (ts.isBindingElement(p) || ts.isVariableDeclaration(p)) return p.name === id;
  if (ts.isImportEqualsDeclaration(p)) return p.name === id;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isPropertyAssignment(p)) return p.name === id;
  return ts.isQualifiedName(p) || ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p);
}

class UncountableFsUse extends Error {}

const REFUSED =
  'reaches node:fs through a shape the ratchet cannot count: an unparsed dynamic import, ' +
  'createRequire, getBuiltinModule, or an fs function or namespace used as a value rather than called';

/** Path-based fs calls in one source file, resolved through the binder. Throws
 *  {@link UncountableFsUse} for a shape it cannot classify, so the file fails the test instead
 *  of counting low. */
function countInFile(sf: ts.SourceFile, checker: ts.TypeChecker): number {
  let calls = 0;
  const refuse = (): never => {
    throw new UncountableFsUse(REFUSED);
  };
  const visit = (node: ts.Node): void => {
    // A CJS route into a builtin has to NAME `createRequire` or `getBuiltinModule` somewhere —
    // at its import, its alias, its destructuring or its call — so any identifier by either name
    // is refused, whatever the binding shape. Neither occurs in this tree.
    if (
      ts.isIdentifier(node) &&
      (node.text === 'createRequire' || node.text === 'getBuiltinModule')
    ) {
      refuse();
    }
    if (isFsLoadCall(node)) {
      // The module as an expression: bound to a name (handled through the binding), or used in
      // place as `(await import('node:fs')).name(`; anything else is a shape not followed.
      let expr: ts.Expression = node;
      if (isDynamicImport(node)) {
        if (!ts.isAwaitExpression(expr.parent)) refuse();
        expr = expr.parent as ts.Expression;
      }
      if (ts.isParenthesizedExpression(expr.parent)) expr = expr.parent;
      const { top } = chainFrom(expr);
      const owner = top.parent;
      if (ts.isVariableDeclaration(owner) && owner.initializer === top) {
        if (!isModuleExpression(top)) refuse();
      } else {
        const use = classifyUse(expr, 'namespace');
        if (use === 'call') calls += 1;
        else if (use === 'value') refuse();
      }
    } else if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const kind = bindingOf(symbol);
      if (kind === 'unknown') {
        refuse();
      } else if (kind !== null) {
        const use = classifyUse(node, kind);
        if (use === 'call') calls += 1;
        else if (use === 'value') refuse();
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/** One program over in-memory sources (no lib, no module resolution: the binder alone answers
 *  which declaration an identifier names), so a whole scan parses once. */
function analyze(sources: Map<string, string>): Map<string, number | UncountableFsUse> {
  // Only files that can bind the module enter the program: parsing the whole tree to scan a
  // sixth of it put the scan past vitest's default timeout on a CI runner.
  const candidates = new Set(
    [...sources].filter(([, text]) => MENTIONS_FS.test(text)).map(([name]) => name),
  );
  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = sources.get(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => sources.has(name),
    readFile: (name) => sources.get(name),
  };
  const program = ts.createProgram(
    [...candidates],
    { noResolve: true, noLib: true, types: [], noEmit: true, target: ts.ScriptTarget.ES2024 },
    host,
  );
  const checker = program.getTypeChecker();
  const out = new Map<string, number | UncountableFsUse>();
  for (const name of sources.keys()) {
    if (!candidates.has(name)) {
      out.set(name, 0);
      continue;
    }
    const sf = program.getSourceFile(name)!;
    try {
      out.set(name, countInFile(sf, checker));
    } catch (err) {
      if (!(err instanceof UncountableFsUse)) throw err;
      out.set(name, err);
    }
  }
  return out;
}

export function countFsCalls(source: string): number {
  const result = analyze(new Map([['/one.ts', source]])).get('/one.ts')!;
  if (result instanceof UncountableFsUse) throw result;
  return result;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') out.push(...sourceFiles(full));
    } else if (/\.[mc]?ts$/.test(entry.name) && !/\.(?:test|d)\.[mc]?ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function measure(): { counts: Record<string, number>; uncountable: string[] } {
  const sources = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      sources.set(
        path.relative(REPO_ROOT, file).split(path.sep).join('/'),
        readFileSync(file, 'utf8'),
      );
    }
  }
  const counts: [string, number][] = [];
  const uncountable: string[] = [];
  for (const [file, result] of analyze(sources)) {
    if (result instanceof UncountableFsUse) uncountable.push(`${file}: ${result.message}`);
    else if (result > 0) counts.push([file, result]);
  }
  counts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { counts: Object.fromEntries(counts), uncountable };
}

describe('path-based fs call ratchet', () => {
  it('counts the forms the baseline is measured in', () => {
    expect(
      countFsCalls(
        "import { readFile, stat } from 'node:fs/promises';\nawait readFile(p); await stat(p); await fh.stat(); open(p);",
      ),
    ).toBe(2);
    expect(
      countFsCalls(
        "import { readFile as readRepoFile } from 'node:fs/promises';\nawait readRepoFile(p); readFile(p);",
      ),
    ).toBe(1);
    expect(
      countFsCalls(
        "import fs from 'node:fs';\nfs.readFileSync(p); fs.promises.rm(p); other.rm(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import * as fsp from 'fs/promises';\nawait fsp.open(p);")).toBe(1);
    expect(
      countFsCalls("import { promises as fsp } from 'node:fs';\nawait fsp.writeFile(p, d);"),
    ).toBe(1);
    expect(
      countFsCalls("import fs, { mkdirSync } from 'node:fs';\nfs.statSync(p); mkdirSync(p);"),
    ).toBe(2);
    expect(countFsCalls("import { default as fs } from 'node:fs';\nfs.readFileSync(p);")).toBe(1);
    expect(
      countFsCalls(
        "import { lstat, readlink, symlink } from 'node:fs/promises';\nawait lstat(p); await readlink(p); await symlink(t, p);",
      ),
    ).toBe(3);
    expect(
      countFsCalls(
        "import fs from 'node:fs';\nfs.realpath.native(p, cb); fs.realpathSync.native(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import { realpath } from 'node:fs';\nrealpath.native(p, cb);")).toBe(1);
    expect(
      countFsCalls(
        "import { mkdtempDisposable } from 'node:fs/promises';\nimport fs from 'node:fs';\nawait mkdtempDisposable(p); fs.mkdtempDisposableSync(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import { constants, type Dirent } from 'node:fs';\nopen(p);")).toBe(0);
    expect(countFsCalls("import type { Dirent } from 'node:fs';\nopen(p);")).toBe(0);
    expect(countFsCalls("import { open } from './mine.js';\nopen(p);")).toBe(0);
  });

  it('follows the binder, not the text', () => {
    // A local shadowing the import, an object key, a comment and a string all name `rm` and
    // `open` without touching the fs bindings; a type position names the module without reading it.
    expect(
      countFsCalls(
        "import { rm, open } from 'node:fs/promises';\nimport type fs from 'node:fs';\n" +
          "const rm2 = await runner.remove(id);\nif (rm2.ok) { const open = 1; log({ open }, 'rm failed'); }\n" +
          '// rm is refused here\nconst x: typeof fs.readFile | null = null;\nawait rm(p); await open(p);',
      ),
    ).toBe(2);
    expect(
      countFsCalls(
        "import fs from 'node:fs';\nconst m = fs.constants.O_RDONLY; const d: fs.Dirent[] = [];\nfs.readFileSync(p);",
      ),
    ).toBe(1);
  });

  it('counts dynamic imports, and refuses a shape it cannot classify', () => {
    expect(
      countFsCalls(
        "const { readFile, stat: statPath } = await import('node:fs/promises');\nawait readFile(p); await statPath(p);",
      ),
    ).toBe(2);
    expect(
      countFsCalls("const fsp = await import('node:fs/promises');\nawait fsp.readFile(p);"),
    ).toBe(1);
    expect(countFsCalls("(await import('node:fs')).readFileSync(p);")).toBe(1);
    expect(
      countFsCalls("const { default: fs } = await import('node:fs');\nfs.readFileSync(p);"),
    ).toBe(1);
    expect(countFsCalls("const fs = (await import('node:fs')).default;\nfs.readFileSync(p);")).toBe(
      1,
    );
    expect(() => countFsCalls("import('node:fs').then((fs) => fs.readFile(p));")).toThrow(
      /cannot count/,
    );
    expect(() => countFsCalls("const fs = process.getBuiltinModule('node:fs');")).toThrow(
      /cannot count/,
    );
    expect(() =>
      countFsCalls("import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)"),
    ).toThrow(/cannot count/);
    expect(
      countFsCalls(
        "const { promises: { readFile }, constants: { O_RDONLY } } = await import('node:fs');\nawait readFile(p); use(O_RDONLY);",
      ),
    ).toBe(1);
    expect(() =>
      countFsCalls("import { createRequire as cr } from 'node:module';\ncr(import.meta.url)"),
    ).toThrow(/cannot count/);
    expect(() => countFsCalls("const { getBuiltinModule: g } = process;\ng('node:fs');")).toThrow(
      /cannot count/,
    );
  });

  it('refuses a bound fs function or namespace used as a value', () => {
    expect(() =>
      countFsCalls(
        "import fs from 'node:fs';\nconst readRepoFile = fs.promises.readFile;\nawait readRepoFile(p);",
      ),
    ).toThrow(/cannot count/);
    expect(() => countFsCalls("import * as fs from 'node:fs';\nconst { readFile } = fs;")).toThrow(
      /cannot count/,
    );
    expect(() => countFsCalls("import fs from 'node:fs';\nconst p = fs.promises;")).toThrow(
      /cannot count/,
    );
    expect(() => countFsCalls("import fs from 'node:fs';\nfs['readFile'](p);")).toThrow(
      /cannot count/,
    );
    expect(() =>
      countFsCalls("import { readFile } from 'node:fs/promises';\nconst f = readFile;\nf(p);"),
    ).toThrow(/cannot count/);
    expect(() =>
      countFsCalls("import { readFile } from 'node:fs/promises';\nfiles.map(readFile);"),
    ).toThrow(/cannot count/);
    expect(() =>
      countFsCalls("import { readFile } from 'node:fs/promises';\nconst api = { readFile };"),
    ).toThrow(/cannot count/);
  });

  it('binds the CommonJS forms a .cts source can use', () => {
    expect(countFsCalls("const fs = require('node:fs');\nfs.readFileSync(p);")).toBe(1);
    expect(countFsCalls("import fs = require('node:fs');\nfs.readFileSync(p);")).toBe(1);
    expect(
      countFsCalls("const { readFile } = require('node:fs/promises');\nawait readFile(p);"),
    ).toBe(1);
    expect(countFsCalls("require('node:fs').readFileSync(p);")).toBe(1);
    expect(countFsCalls("const m = module.require('node:fs');\nm.readFileSync(p);")).toBe(1);
    expect(countFsCalls("const fsp = require('node:fs').promises;\nawait fsp.readFile(p);")).toBe(
      1,
    );
    expect(() =>
      countFsCalls("const p = import('node:fs');\np.then((m) => m.readFile(x));"),
    ).toThrow(/cannot count/);
    expect(() => countFsCalls("load(require('node:fs'));")).toThrow(/cannot count/);
  });

  it('binds object rest as the module and counts the stream constructors', () => {
    expect(
      countFsCalls("const { ...fsp } = await import('node:fs/promises');\nawait fsp.readFile(p);"),
    ).toBe(1);
    expect(
      countFsCalls(
        "const { promises: { ...fsp } } = await import('node:fs');\nawait fsp.readFile(p);",
      ),
    ).toBe(1);
    expect(countFsCalls("const { constants: { ...c } } = await import('node:fs');\nuse(c);")).toBe(
      0,
    );
    expect(countFsCalls("import fs from 'node:fs';\nnew fs.ReadStream(p);")).toBe(1);
    expect(countFsCalls("import { WriteStream } from 'node:fs';\nnew WriteStream(p);")).toBe(1);
    expect(
      countFsCalls(
        "import fs, { type ReadStream } from 'node:fs';\nconst ok = (s: ReadStream) => s instanceof fs.ReadStream;\nfs.createReadStream(p);",
      ),
    ).toBe(1);
  });

  it('matches the per-file baseline exactly', () => {
    const { counts: current, uncountable } = measure();
    if (process.env.UPDATE_FS_RATCHET) {
      writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
    const problems: string[] = [...uncountable];
    for (const [file, n] of Object.entries(current)) {
      const pinned = baseline[file] ?? 0;
      if (n !== pinned)
        problems.push(`${file}: ${n} path-based fs call(s), baseline says ${pinned}`);
    }
    for (const file of Object.keys(baseline)) {
      if (!(file in current)) problems.push(`${file}: in the baseline but has no such calls now`);
    }
    expect(
      problems,
      'Path-based node:fs calls on repository paths go through @haive/shared/fs-safe. ' +
        'If a change here is intended, refresh the baseline with UPDATE_FS_RATCHET=1 and say why in the PR.',
    ).toEqual([]);
    // ~2 s here; a CI runner sharing its cores with the other vitest workers has been measured
    // at 10 s, past the 5 s default.
  }, 60_000);
});
