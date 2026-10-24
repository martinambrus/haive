import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TRANSPORTS = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone']);

/** Follow argv initializers and .push additions within their lexical function.
 * This catches both inline arrays and the credential-prefixed argv our helpers build.
 * An argv returned by a helper call is invisible to this scan. */
function unvalidatedOriginCalls(
  text: string,
  definesOrigin = false,
  definesClone = false,
  definesLocalFetch = false,
): number[] {
  const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const bindings = new Map<ts.Node, Map<string, ts.Node[]>>();
  const validated = new Set<string>(definesOrigin ? ['originGitRun'] : []);
  function scope(node: ts.Node): ts.Node {
    let at = node.parent;
    while (at && !ts.isFunctionLike(at) && !ts.isSourceFile(at)) at = at.parent;
    return at ?? file;
  }
  function bind(node: ts.Node, name: string, values: readonly ts.Node[]) {
    const owner = scope(node);
    const names = bindings.get(owner) ?? new Map<string, ts.Node[]>();
    names.set(name, [...(names.get(name) ?? []), ...values]);
    bindings.set(owner, names);
  }
  function collect(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith('/git-push.js')
    ) {
      const imports = node.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports)) {
        for (const item of imports.elements) {
          if ((item.propertyName ?? item.name).text === 'originGitRun')
            validated.add(item.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      bind(node, node.name.text, [node.initializer]);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      ts.isIdentifier(node.expression.expression)
    )
      bind(node, node.expression.expression.text, node.arguments);
    ts.forEachChild(node, collect);
  }
  collect(file);
  function strings(node: ts.Node, seen = new Set<ts.Node>()): string[] {
    if (seen.has(node)) return [];
    seen.add(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node)) {
      let owner = scope(node);
      for (;;) {
        const values = bindings.get(owner)?.get(node.text);
        if (values) return values.flatMap((value) => strings(value, seen));
        if (owner === file) return [];
        owner = scope(owner);
      }
    }
    if (
      ts.isFunctionLike(node) ||
      ts.isBinaryExpression(node) ||
      ts.isPropertyAccessExpression(node)
    )
      return [];
    if (ts.isCallExpression(node) && node.expression.getText(file) !== 'hardenGitArgs') return [];
    const out: string[] = [];
    ts.forEachChild(node, (child) => {
      out.push(...strings(child, seen));
    });
    return out;
  }
  const offenders: number[] = [];
  function insideClone(node: ts.Node): boolean {
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name?.text === 'gitClone') return definesClone;
    }
    return false;
  }
  function check(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const assembly = ts.isPropertyAccessExpression(callee) && callee.name.text === 'push';
      const safe =
        ts.isIdentifier(callee) && (validated.has(callee.text) || callee.text === 'hardenGitArgs');
      const args = node.arguments.flatMap((arg) => strings(arg));
      const localFetch =
        definesLocalFetch &&
        args.includes('fetch') &&
        args.includes('--') &&
        !args.includes('origin');
      const transport =
        args.some((arg) => TRANSPORTS.has(arg)) ||
        (args.includes('remote') && args.includes('update'));
      if (!assembly && !safe && !insideClone(node) && !localFetch && transport)
        offenders.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, check);
  }
  check(file);
  return offenders;
}

describe('origin network operations', () => {
  it('flags transport calls through aliases, inline argv and assembled argv', () => {
    for (const command of TRANSPORTS) {
      expect(unvalidatedOriginCalls(`run(cwd, ['${command}', 'origin']);`)).toHaveLength(1);
      expect(
        unvalidatedOriginCalls(
          `const argv = ['${command}']; argv.push('origin'); alias(cwd, argv);`,
        ),
      ).toHaveLength(1);
      expect(
        unvalidatedOriginCalls(`spawn('git', hardenGitArgs(['${command}', 'origin']));`).length,
      ).toBeGreaterThan(0);
    }
    expect(
      unvalidatedOriginCalls("run(cwd, ['fetch', '--', localPath, 'main']);", false, false, true),
    ).toEqual([]);
    expect(
      unvalidatedOriginCalls(
        "import { originGitRun } from './git-push.js'; originGitRun(cwd, ['fetch', 'origin']);",
      ),
    ).toEqual([]);
  });

  it('flags implicit transports and clone calls without an origin token', () => {
    for (const argv of [
      "['fetch']",
      "['pull', '--ff-only']",
      "['push']",
      "['ls-remote']",
      "['remote', 'update']",
      "['clone', url, dest]",
    ]) {
      expect(unvalidatedOriginCalls(`run(cwd, ${argv});`), argv).toHaveLength(1);
      expect(
        unvalidatedOriginCalls(`spawn('git', hardenGitArgs(${argv}));`).length,
        argv,
      ).toBeGreaterThan(0);
    }
  });

  it('uses originGitRun throughout server sources and operator scripts, and catches a bypass in each guarded file', async () => {
    const offenders: string[] = [];
    let guardedFiles = 0;
    const modules = await readdir(path.join(ROOT, 'modules'), { withFileTypes: true });
    const roots = [
      'packages/worker/src',
      'packages/worker/scripts',
      'packages/api/src',
      'packages/shared/src',
      ...modules
        .filter((m) => m.isDirectory() && existsSync(path.join(ROOT, 'modules', m.name, 'src')))
        .map((m) => `modules/${m.name}/src`),
    ];
    for (const root of roots) {
      for (const rel of await readdir(path.join(ROOT, root), { recursive: true })) {
        if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
        const name = `${root}/${rel}`;
        const text = await readFile(path.join(ROOT, name), 'utf8');
        for (const line of unvalidatedOriginCalls(
          text,
          name === 'packages/worker/src/repo/git-push.ts',
          name === 'packages/worker/src/repo/clone.ts',
          name === 'packages/worker/src/repo/refresh.ts',
        ))
          offenders.push(`${name}:${line}`);
        if (/\boriginGitRun\(/.test(text)) {
          const bypassed = text.replace(/\boriginGitRun\(/g, 'gitRun(');
          expect(unvalidatedOriginCalls(bypassed).length, name).toBeGreaterThan(0);
          guardedFiles++;
        }
      }
    }
    expect(guardedFiles).toBeGreaterThanOrEqual(9);
    expect(offenders).toEqual([]);
  });
});
