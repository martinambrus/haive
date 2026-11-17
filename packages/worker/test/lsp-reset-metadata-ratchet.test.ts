import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

// A task's retained image ownership must survive every Retry/Resume branch.
// This conservative ratchet refuses any metadata identifier/key in either reset
// implementation, including a computed key or an intermediate spread object.
for (const file of ['../src/queues/_step-reset.ts', '../../api/src/routes/tasks/steps.ts']) {
  it(`${file} never sets task metadata`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const violations: number[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node)) && node.text === 'metadata')
        violations.push(tree.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(violations).toEqual([]);
  });
}
