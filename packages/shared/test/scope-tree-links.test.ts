import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildScopeTree, REPO_ROOT_NODE_PATH, ROOT_FILES_SCOPE } from '../src/repo/scope-tree.js';
import type { TreeNode } from '../src/schemas/form.js';

const run = promisify(execFile);

function children(tree: TreeNode[]): TreeNode[] {
  expect(tree[0]?.path).toBe(REPO_ROOT_NODE_PATH);
  return tree[0]?.children ?? [];
}

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => n.path).sort();
}

// The scope tree is walked host-side off the repos volume for a repository nobody vets, so a
// linked directory in it must not be descended into and a linked file must not be counted: the
// picker would otherwise offer — and RAG would index — a tree that lives somewhere else.
describe('buildScopeTree containment', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'scope-repo-'));
    outside = await mkdtemp(path.join(tmpdir(), 'scope-out-'));
    await mkdir(path.join(repo, 'src', 'inner'), { recursive: true });
    await writeFile(path.join(repo, 'index.php'), '<?php', 'utf8');
    await writeFile(path.join(repo, 'src', 'a.php'), '<?php', 'utf8');
    await writeFile(path.join(repo, 'src', 'inner', 'b.php'), '<?php', 'utf8');
    await mkdir(path.join(outside, 'secret'), { recursive: true });
    await writeFile(path.join(outside, 'secret', 'c.php'), '<?php', 'utf8');
    await writeFile(path.join(outside, 'loose.php'), '<?php', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('walks a real tree, counting each directory’s own files', async () => {
    const top = children(await buildScopeTree(repo, { extensions: new Set(['.php']) }));
    expect(names(top)).toEqual([ROOT_FILES_SCOPE, 'src']);
    expect(top.find((n) => n.path === ROOT_FILES_SCOPE)?.fileCount).toBe(1);
    const src = top.find((n) => n.path === 'src');
    expect(src?.fileCount).toBe(1);
    expect(names(src?.children ?? [])).toEqual(['src/inner']);
  });

  it('drops a linked directory instead of descending into it', async () => {
    await symlink(path.join(outside, 'secret'), path.join(repo, 'vendored'));
    const top = children(await buildScopeTree(repo, { extensions: new Set(['.php']) }));
    // A Dirent for a link is not a directory, so the node never appears; had the walk followed
    // it, `vendored` would be listed with the outside tree's file count.
    expect(names(top)).toEqual([ROOT_FILES_SCOPE, 'src']);
  });

  it('descends a real directory whose own child is a link', async () => {
    await symlink(path.join(outside, 'secret'), path.join(repo, 'src', 'linked'));
    const top = children(await buildScopeTree(repo, { extensions: new Set(['.php']) }));
    const src = top.find((n) => n.path === 'src');
    expect(names(src?.children ?? [])).toEqual(['src/inner']);
    expect(src?.fileCount).toBe(1);
  });

  it('does not count a linked file among a directory’s files', async () => {
    await symlink(path.join(outside, 'loose.php'), path.join(repo, 'src', 'linked.php'));
    const top = children(await buildScopeTree(repo, { extensions: new Set(['.php']) }));
    expect(top.find((n) => n.path === 'src')?.fileCount).toBe(1);
  });

  it('still walks a root reached through a link, since the anchor may be one', async () => {
    // A repository's `storage_path` can itself be reached through a link, so the anchor is the one
    // component the walk follows. Only the path BELOW it is refused component by component.
    await symlink(repo, path.join(outside, 'via'));
    expect(names(children(await buildScopeTree(path.join(outside, 'via'))))).toContain('src');
  });

  it('is empty for a root that is a FIFO or missing', async () => {
    await run('mkfifo', [path.join(repo, 'pipe')]);
    expect(await buildScopeTree(path.join(repo, 'pipe'))).toEqual([]);
    expect(await buildScopeTree(path.join(repo, 'nope'))).toEqual([]);
  });
});
