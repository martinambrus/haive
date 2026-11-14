import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('step prompts use the bounded helper; only its exact implementation may import full renderers', async () => {
  const root = fileURLToPath(new URL('../src/step-engine/steps/', import.meta.url));
  async function files(dir: string): Promise<string[]> {
    return (
      await Promise.all(
        (await readdir(dir, { withFileTypes: true })).map((e) =>
          e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
        ),
      )
    ).flat();
  }
  const violations: string[] = [];
  for (const file of await files(root)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    // The complete mirror lives outside steps/ and intentionally renders every node.
    // This ONE helper is the bounded rendering boundary, never a prompt builder.
    if (relative(root, file) === 'plan/_plan-index.ts') continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(n: ts.Node) {
      if (ts.isIdentifier(n) && /^renderPlanMarkdown(?:From|FromMirror)?$/.test(n.text))
        violations.push(
          `${relative(root, file)}:${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
        );
      ts.forEachChild(n, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
