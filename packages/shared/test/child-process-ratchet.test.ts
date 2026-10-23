import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Pins, per source file, the child_process call sites whose command is not provably a plain
// non-git program, so a new one lands where a reviewer sees it (git-exec-guard sees only `fn('git')`).
// Exact counts, so the baseline cannot drift stale in either direction.
// Refresh:  UPDATE_CHILD_PROCESS_RATCHET=1 pnpm --filter @haive/shared test

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE = path.join(HERE, 'child-process-ratchet.json');
const FUNCTIONS = new Set([
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'fork',
]);
const WRAPPERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ash',
  'ksh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
  'env',
  'xargs',
  'sudo',
  'timeout',
  'nice',
  'nohup',
  'busybox',
  'script',
  'su',
  'doas',
]);
const MODULE = /^(node:)?child_process$/;
const PROMISIFY = /^(util\.)?promisify$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'test', 'tests', '__tests__']);

interface Site {
  line: number;
  fn: string;
  why: string;
}

function isModuleLoad(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
      node.expression.kind === ts.SyntaxKind.ImportKeyword) &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteral(node.arguments[0]) &&
    MODULE.test(node.arguments[0].text)
  );
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function findChildProcessSites(fileName: string, text: string): Site[] {
  if (!text.includes('child_process')) return [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const bound = new Map<string, string>();
  const declared = new Set<ts.Node>();

  const bindNames = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      bound.set(name.text, '*');
      declared.add(name);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) continue;
      bound.set(element.name.text, (element.propertyName ?? element.name).getText(sf));
      declared.add(element.name);
      if (element.propertyName) declared.add(element.propertyName);
    }
  };

  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      MODULE.test(node.moduleSpecifier.text) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const clause = node.importClause;
      if (clause.name) {
        bound.set(clause.name.text, '*');
        declared.add(clause.name);
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bound.set(named.name.text, '*');
        declared.add(named.name);
      }
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          bound.set(element.name.text, (element.propertyName ?? element.name).text);
          declared.add(element.name);
          if (element.propertyName) declared.add(element.propertyName);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (isModuleLoad(init)) bindNames(node.name);
      if (
        ts.isCallExpression(init) &&
        PROMISIFY.test(init.expression.getText(sf)) &&
        init.arguments[0] &&
        ts.isIdentifier(init.arguments[0]) &&
        bound.has(init.arguments[0].text) &&
        ts.isIdentifier(node.name)
      ) {
        bound.set(node.name.text, bound.get(init.arguments[0].text) as string);
        declared.add(node.name);
        declared.add(init.arguments[0]);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const sites: Site[] = [];
  const refuse = (node: ts.Node, what: string): never => {
    throw new Error(
      `${fileName}:${lineOf(node)}: ${what}; the child_process ratchet cannot count it`,
    );
  };

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && ['createRequire', 'getBuiltinModule'].includes(node.text)) {
      refuse(node, `${node.text} can load child_process unseen`);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'binding'
    ) {
      refuse(node, 'process.binding can load child_process unseen');
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let fn: string | null = null;
      if (ts.isIdentifier(callee) && FUNCTIONS.has(bound.get(callee.text) ?? '')) {
        fn = bound.get(callee.text) as string;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bound.get(callee.expression.text) === '*' &&
        FUNCTIONS.has(callee.name.text)
      ) {
        fn = callee.name.text;
      }
      if (fn) {
        const first = node.arguments[0];
        let why: string | null = null;
        if (!first) why = 'no command argument';
        else if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
          const literal = first.text.trim();
          const base = path.basename(literal.split(/\s+/)[0] ?? '');
          if (/\s/.test(literal)) why = `shell string "${literal.slice(0, 30)}"`;
          else if (base === 'git' || base === 'git.exe') why = `git literal "${literal}"`;
          else if (WRAPPERS.has(base)) why = `shell wrapper "${literal}"`;
        } else why = `non-literal ${first.getText(sf).slice(0, 40)}`;
        if (why) sites.push({ line: lineOf(node), fn, why });
      }
    }
    if (ts.isIdentifier(node) && bound.has(node.text) && !declared.has(node)) {
      const parent = node.parent;
      const allowed =
        (ts.isCallExpression(parent) &&
          (parent.expression === node ||
            (PROMISIFY.test(parent.expression.getText(sf)) && parent.arguments[0] === node))) ||
        (ts.isPropertyAccessExpression(parent) &&
          (parent.expression === node || parent.name === node)) ||
        ts.isTypeReferenceNode(parent) ||
        ts.isQualifiedName(parent) ||
        ts.isTypeQueryNode(parent) ||
        ts.isExportSpecifier(parent) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node);
      if (!allowed) refuse(node, `${node.text} is used as a value`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function scanRoots(): string[] {
  const roots: string[] = [];
  for (const pkg of readdirSync(path.join(REPO_ROOT, 'packages'))) {
    for (const dir of ['src', 'scripts']) {
      if (existsSync(path.join(REPO_ROOT, 'packages', pkg, dir))) {
        roots.push(`packages/${pkg}/${dir}`);
      }
    }
  }
  for (const name of readdirSync(path.join(REPO_ROOT, 'modules'))) {
    if (existsSync(path.join(REPO_ROOT, 'modules', name, 'src'))) roots.push(`modules/${name}/src`);
  }
  roots.push('scripts');
  return roots;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function scanTree(): Map<string, Site[]> {
  const found = new Map<string, Site[]>();
  for (const root of scanRoots()) {
    const dir = path.join(REPO_ROOT, root);
    if (!existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      const rel = path.relative(REPO_ROOT, file);
      const sites = findChildProcessSites(rel, readFileSync(file, 'utf8'));
      if (sites.length > 0) found.set(rel, sites);
    }
  }
  return found;
}

const RULE =
  'a command that can be git must go through gitRun / hardenGitArgs (packages/worker/src/repo/git-exec.ts); a plain non-git program should be a string literal; then update the baseline (UPDATE_CHILD_PROCESS_RATCHET=1 pnpm --filter @haive/shared test)';

function readBaseline(): Record<string, number> {
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
}

describe('child_process ratchet', () => {
  const found = scanTree();

  it('the tree matches the baseline exactly', () => {
    const counts = Object.fromEntries(
      [...found.entries()]
        .map(([file, sites]): [string, number] => [file, sites.length])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    if (process.env.UPDATE_CHILD_PROCESS_RATCHET === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    }
    const baseline = readBaseline();
    const moved: string[] = [];
    for (const file of new Set([...Object.keys(baseline), ...Object.keys(counts)])) {
      const before = baseline[file] ?? 0;
      const after = counts[file] ?? 0;
      if (before === after) continue;
      const sites = (found.get(file) ?? []).map((s) => `  ${file}:${s.line} ${s.fn} ${s.why}`);
      moved.push(`${file}: ${before} -> ${after}\n${sites.join('\n')}`);
    }
    expect(moved, `${moved.join('\n')}\n${RULE}`).toEqual([]);
  });

  it('the baseline lists no file that is gone or counts 0', () => {
    const stale = Object.entries(readBaseline())
      .filter(([file, count]) => count < 1 || !existsSync(path.join(REPO_ROOT, file)))
      .map(([file]) => file);
    expect(stale).toEqual([]);
  });
});

describe('child_process ratchet self-tests', () => {
  const count = (text: string) => findChildProcessSites('probe.ts', text).length;

  it.each([
    [
      'exec with a git shell string',
      `import { exec } from 'node:child_process'; exec('git status')`,
    ],
    [
      'execSync with a git template',
      'import { execSync } from "node:child_process"; execSync(`git ${x}`)',
    ],
    [
      'spawn with a variable command',
      `import { spawn } from 'node:child_process'; spawn(cmd, args)`,
    ],
    [
      'spawn of an absolute git path',
      `import { spawn } from 'node:child_process'; spawn('/usr/bin/git', a)`,
    ],
    [
      'spawn of a shell wrapper',
      `import { spawn } from 'node:child_process'; spawn('bash', ['-c', 'git log'])`,
    ],
    [
      'a promisified alias',
      `import { execFile } from 'node:child_process'; const run = promisify(execFile); run(bin, a)`,
    ],
    ['a namespace import', `import * as cp from 'node:child_process'; cp.spawn(x)`],
    [
      'a dynamic import',
      `async function f() { const { spawn } = await import('node:child_process'); spawn(x) }`,
    ],
    ['a require destructure', `const { execFileSync } = require('child_process'); execFileSync(x)`],
    [
      'git with hardened args',
      `import { spawn } from 'node:child_process'; spawn('git', hardenGitArgs(a))`,
    ],
    ['fork with no argument', `import { fork } from 'node:child_process'; fork()`],
  ])('flags %s exactly once', (_name, text) => {
    expect(count(text)).toBe(1);
  });

  it.each([
    ['a plain program', `import { spawn } from 'node:child_process'; spawn('docker', ['ps'])`],
    [
      'execFile of a plain literal',
      `import { execFile } from 'node:child_process'; execFile('pnpm', a)`,
    ],
    ['a string that only mentions exec(git)', `const s = 'exec(git) child_process';`],
    [
      'a template program that requires child_process',
      "const program = `const cp = require('node:child_process'); cp.spawn(x)`;",
    ],
    [
      'a local function named spawn',
      `import { exec } from 'node:child_process'; function spawn(x: string) { return x } spawn(cmd)`,
    ],
  ])('does not flag %s', (_name, text) => {
    expect(count(text)).toBe(0);
  });

  it.each([
    [
      'a bound function used as a value',
      `import { spawn } from 'node:child_process'; const s = spawn;`,
    ],
    ['createRequire', `createRequire(import.meta.url)('child_process')`],
  ])('refuses %s', (_name, text) => {
    expect(() => count(text)).toThrow(/probe\.ts/);
  });
});
