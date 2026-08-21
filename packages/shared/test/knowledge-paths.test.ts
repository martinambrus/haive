import { describe, expect, it } from 'vitest';
import {
  KB_DIR,
  LEARNINGS_DIR,
  MANAGED_KNOWLEDGE_BADGE,
  stripManagedKnowledgeGlobs,
  tagManagedKnowledgeNodes,
} from '../src/knowledge-paths.js';
import { ROOT_FILES_SCOPE } from '../src/repo/scope-tree.js';
import type { TreeNode } from '../src/schemas/form.js';

describe('stripManagedKnowledgeGlobs', () => {
  it('leaves an ordinary deny list untouched', () => {
    const globs = ['vendor', 'web/core', 'node_modules'];
    expect(stripManagedKnowledgeGlobs(globs)).toEqual(globs);
  });

  it('drops a glob that IS a managed knowledge dir', () => {
    expect(stripManagedKnowledgeGlobs(['vendor', KB_DIR, LEARNINGS_DIR])).toEqual(['vendor']);
  });

  it('drops an ANCESTOR glob that would cover the knowledge dirs', () => {
    expect(stripManagedKnowledgeGlobs(['.haive-data', 'vendor'])).toEqual(['vendor']);
  });

  it('drops a DESCENDANT glob that would exclude part of the knowledge tree', () => {
    expect(stripManagedKnowledgeGlobs([`${KB_DIR}/investigations`])).toEqual([]);
  });

  it('normalizes surrounding slashes before matching', () => {
    expect(stripManagedKnowledgeGlobs([`/${KB_DIR}/`, '/vendor/'])).toEqual(['/vendor/']);
  });

  it('keeps a sibling dir whose name merely shares a prefix', () => {
    const globs = ['.haive-database', '.haive', `${KB_DIR}x`];
    expect(stripManagedKnowledgeGlobs(globs)).toEqual(globs);
  });

  it('keeps the root-files token and empty entries', () => {
    expect(stripManagedKnowledgeGlobs([ROOT_FILES_SCOPE, ''])).toEqual([ROOT_FILES_SCOPE, '']);
  });
});

describe('tagManagedKnowledgeNodes', () => {
  const tree: TreeNode[] = [
    {
      path: '__repo_root__',
      label: 'Repository root',
      kind: 'repo-root',
      children: [
        { path: 'src', label: 'src', fileCount: 3 },
        {
          path: '.haive-data',
          label: '.haive-data',
          children: [
            { path: KB_DIR, label: 'knowledge_base' },
            { path: LEARNINGS_DIR, label: 'learnings' },
          ],
        },
      ],
    },
  ];

  it('badges the managed knowledge dirs and nothing else', () => {
    const [root] = tagManagedKnowledgeNodes(tree);
    const dataDir = root!.children![1]!;
    expect(dataDir.badge).toBeUndefined();
    expect(dataDir.children!.map((n) => [n.path, n.badge, n.badgeColor])).toEqual([
      [KB_DIR, MANAGED_KNOWLEDGE_BADGE, 'green'],
      [LEARNINGS_DIR, MANAGED_KNOWLEDGE_BADGE, 'green'],
    ]);
    expect(root!.children![0]!.badge).toBeUndefined();
  });

  it('does not mutate the input tree', () => {
    tagManagedKnowledgeNodes(tree);
    expect(tree[0]!.children![1]!.children![0]!.badge).toBeUndefined();
  });
});
