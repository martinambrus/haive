import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
it('keeps navigation links free of nested button controls throughout the web app', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const nested: string[] = [];
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    const tree = ts.createSourceFile(
      file,
      readFileSync(`${root}/${file}`, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const walk = (node: ts.Node, inLink = false) => {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(tree);
        if (inLink && (tag === 'button' || tag === 'Button'))
          nested.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        for (const child of node.children) walk(child, inLink || tag === 'Link' || tag === 'a');
      } else ts.forEachChild(node, (child) => walk(child, inLink));
    };
    walk(tree);
  }
  expect(nested).toEqual([]);
});
