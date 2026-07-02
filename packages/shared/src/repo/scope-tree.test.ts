import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TreeNode } from '../schemas/form.js';
import { buildScopeTree, NO_RECURSE_DIRS } from './scope-tree.js';

function find(nodes: TreeNode[], label: string): TreeNode | undefined {
  return nodes.find((n) => n.label === label);
}

describe('buildScopeTree', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'scope-tree-'));
    // Custom code with a nested subdir.
    await mkdir(path.join(root, 'src', 'lib'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export {};');
    await writeFile(path.join(root, 'src', 'lib', 'util.ts'), 'export {};');
    // Hidden folder — the old walkers dropped these; the new one must show it.
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: ci');
    // Huge dir that must be SHOWN but NOT recursed into.
    await mkdir(path.join(root, 'node_modules', 'foo', 'deep'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'bar.js'), '');
    // A root-level file (should not appear as a dir node).
    await writeFile(path.join(root, 'README.md'), '# readme');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('shows hidden (dot) folders as first-class nodes', async () => {
    const tree = await buildScopeTree(root);
    const github = find(tree, '.github');
    expect(github).toBeDefined();
    expect(github?.path).toBe('.github');
    // and it recurses into non-NO_RECURSE hidden folders
    expect(find(github?.children ?? [], 'workflows')).toBeDefined();
  });

  it('shows NO_RECURSE dirs but does not descend into them', async () => {
    const tree = await buildScopeTree(root);
    const nm = find(tree, 'node_modules');
    expect(nm).toBeDefined();
    expect(NO_RECURSE_DIRS.has('node_modules')).toBe(true);
    // present, but no children materialised (foo/deep must NOT be walked)
    expect(nm?.children).toBeUndefined();
  });

  it('recurses ordinary dirs and counts files by extension', async () => {
    const tree = await buildScopeTree(root, { extensions: new Set(['.ts']) });
    const src = find(tree, 'src');
    expect(src?.fileCount).toBe(1); // index.ts (util.ts lives under src/lib)
    const lib = find(src?.children ?? [], 'lib');
    expect(lib?.fileCount).toBe(1); // util.ts
  });

  it('honours maxDepth', async () => {
    const tree = await buildScopeTree(root, { maxDepth: 1 });
    const src = find(tree, 'src');
    // depth 1 = src itself; its children (lib) must not be walked
    expect(src?.children).toBeUndefined();
  });
});
