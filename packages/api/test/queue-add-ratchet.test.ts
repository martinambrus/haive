import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const WRAPPERS = new Map([
  ['boundedAdd', 0],
  ['addBestEffort', 0],
  ['addOrRefuse', 0],
  // This wrapper also compensates the committed bundle state on failure.
  ['addBundleJobOrMarkFailed', 2],
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
  });
}

function wrapped(node: ts.Node): boolean {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.arguments[WRAPPERS.get(parent.expression.text) ?? -1] === current &&
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    )
      return true;
  }
  return false;
}

it('bounds every API queue add, including modules and libraries (repos.ts is T550’s explicit exclusion)', () => {
  const files = sources(SRC);
  const configPath = join(import.meta.dirname, '../tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(SRC, '..'));
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const unbounded: string[] = [];
  let queues = 0;
  for (const file of files) {
    if (relative(SRC, file) === 'routes/repos.ts') continue;
    const source = program.getSourceFile(file)!;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['add', 'addBulk'].includes(node.expression.name.text)
      ) {
        const receiver = checker.getTypeAtLocation(node.expression.expression);
        if (receiver.getSymbol()?.name === 'Queue') {
          queues++;
          if (!wrapped(node)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            unbounded.push(`${relative(SRC, file)}:${line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // Prove type resolution actually found BullMQ calls instead of silently accepting an empty scan.
  expect(queues).toBeGreaterThan(40);
  expect(unbounded).toEqual([]);
  const bundles = readFileSync(join(SRC, 'routes/bundles.ts'), 'utf8');
  expect(bundles).toMatch(/await (?:boundedAdd|addOrRefuse)\(add/);
}, 30_000);
