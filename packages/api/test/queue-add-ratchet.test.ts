import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { beforeAll, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const WRAPPERS = new Map([
  ['boundedAdd', 0],
  ['addBestEffort', 0],
  ['addOrRefuse', 0],
  // This wrapper also compensates the committed bundle state on failure.
  ['addBundleJobOrMarkFailed', 2],
  ['addRepoJobOrMarkError', 2],
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : file.endsWith('.ts') ? [file] : [];
  });
}

function wrapped(node: ts.Node, checker: ts.TypeChecker): boolean {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (!ts.isCallExpression(parent)) continue;
    const declaration = checker.getResolvedSignature(parent)?.declaration;
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.name) continue;
    const name = declaration.name.text;
    const owner = declaration.getSourceFile().fileName;
    const trusted =
      name === 'addBundleJobOrMarkFailed'
        ? owner === join(SRC, 'routes/bundles.ts')
        : name === 'addRepoJobOrMarkError'
          ? owner === join(SRC, 'routes/repos.ts')
          : owner === join(SRC, 'lib/queue-bounded.ts');
    if (
      trusted &&
      parent.arguments[WRAPPERS.get(name) ?? -1] === current &&
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
    )
      return true;
  }
  return false;
}

function scan(source: ts.SourceFile, checker: ts.TypeChecker) {
  const unbounded: string[] = [];
  let queues = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['add', 'addBulk'].includes(node.expression.name.text)
    ) {
      const receiver = checker.getTypeAtLocation(node.expression.expression);
      const declaration = checker.getResolvedSignature(node)?.declaration;
      const owner = declaration?.parent;
      // Inherited, optional and mapped receivers retain the BullMQ method declaration.
      const bullmq =
        declaration &&
        owner &&
        ts.isClassDeclaration(owner) &&
        ['Queue', 'QueueBase'].includes(owner.name?.text ?? '') &&
        /\/bullmq\/.*\/classes\/queue(?:-base)?\.d\.ts$/.test(declaration.getSourceFile().fileName);
      const anyReceiver = (receiver.flags & ts.TypeFlags.Any) !== 0;
      if (bullmq || anyReceiver) {
        queues++;
        // An any receiver cannot prove which implementation is called, even inside a helper.
        if (anyReceiver || !wrapped(node, checker)) unbounded.push(node.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { queues, unbounded };
}

// Virtual fixture: typechecked with the same BullMQ and helper declarations as production.
const FIXTURE = join(SRC, 'queue-add-ratchet-fixture.ts');
const mutants = [
  "queue.add('direct', {})",
  "maybe()?.add('optional', {})",
  "sub.add('subclass', {})",
  "pick.add('pick', {})",
  "wrapper().add('wrapper', {})",
  "queue.addBulk([{ name: 'bulk', data: {} }])",
  "maybe()?.addBulk([{ name: 'optional-bulk', data: {} }])",
  "sub.addBulk([{ name: 'subclass-bulk', data: {} }])",
  "bulkPick.addBulk([{ name: 'pick-bulk', data: {} }])",
  "wrapper().addBulk([{ name: 'wrapper-bulk', data: {} }])",
  "unknownQueue.add('any', {})",
  'unknownQueue.addBulk([])',
  "queue.add('spoofed-helper', {})",
];
const fixture = `
import { Queue } from 'bullmq';
import { boundedAdd as bound, addBestEffort, addOrRefuse } from './lib/queue-bounded.js';
declare const queue: Queue;
declare function maybe(): Queue | undefined;
class SubQueue extends Queue {}
declare const sub: SubQueue;
declare const pick: Pick<Queue, 'add'>;
declare const bulkPick: Pick<Queue, 'addBulk'>;
declare const unknownQueue: any;
function wrapper(): Pick<Queue, 'add' | 'addBulk'> { return queue; }
function boundedAdd<T>(work: () => T): T { return work(); }
${mutants
  .slice(0, -1)
  .map((call) => `${call};`)
  .join('\n')}
boundedAdd(() => ${mutants.at(-1)});
bound(() => queue.add('bounded', {}));
addBestEffort(() => sub.add('best-effort', {}), 'test');
addOrRefuse(() => pick.add('refuse', {}), 'test');
new Set<string>().add('ordinary-add');
`;
let program: ts.Program;
let checker: ts.TypeChecker;
let files: string[];
beforeAll(() => {
  files = sources(SRC);
  const config = ts.readConfigFile(join(SRC, '../tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(SRC, '..'));
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) =>
    file === FIXTURE
      ? ts.createSourceFile(file, fixture, ts.ScriptTarget.Latest, true)
      : getSourceFile(file, ...args);
  program = ts.createProgram([...files, FIXTURE], { ...parsed.options, noEmit: true }, host);
  checker = program.getTypeChecker();
}, 30_000);

it('bounds every API queue add, including modules and libraries', () => {
  let queues = 0;
  const unbounded: string[] = [];
  for (const file of files) {
    const found = scan(program.getSourceFile(file)!, checker);
    queues += found.queues;
    unbounded.push(...found.unbounded.map((call) => `${relative(SRC, file)}: ${call}`));
  }
  expect(queues).toBeGreaterThan(40);
  expect(unbounded).toEqual([]);
  expect(readFileSync(join(SRC, 'routes/bundles.ts'), 'utf8')).toMatch(
    /await (?:boundedAdd|addOrRefuse)\(add/,
  );
  expect(readFileSync(join(SRC, 'routes/repos.ts'), 'utf8')).toMatch(/await boundedAdd\(add/);
});

it('resolves the mutant fixture without type errors', () => {
  expect(program.getSemanticDiagnostics(program.getSourceFile(FIXTURE)!)).toEqual([]);
});
it.each(mutants)('catches the unbounded mutant: %s', (mutant) => {
  expect(scan(program.getSourceFile(FIXTURE)!, checker).unbounded).toContain(mutant);
});
it('accepts only real helper declarations, including aliases, and ignores ordinary adds', () => {
  expect(scan(program.getSourceFile(FIXTURE)!, checker).unbounded).toEqual(mutants);
});
