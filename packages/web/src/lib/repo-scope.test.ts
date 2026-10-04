import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@haive/shared';
import { preserveUnseenScopeExclusions } from './repo-scope';

const tree: TreeNode[] = [
  {
    path: '__repo_root__',
    label: 'Repository root',
    kind: 'repo-root',
    children: [
      { path: '.git', label: '.git' },
      { path: 'web', label: 'web', children: [{ path: 'web/sites', label: 'sites' }] },
    ],
  },
];

describe('preserveUnseenScopeExclusions', () => {
  it('keeps worktree dependency exclusions while editing a checkout before installation', () => {
    expect(
      preserveUnseenScopeExclusions(tree, ['.git', 'web/sites'], ['vendor', 'web/core']),
    ).toEqual(['.git', 'web/sites', 'vendor', 'web/core']);
  });

  it('lets the user re-enable a visible folder without restoring its old exclusion', () => {
    expect(preserveUnseenScopeExclusions(tree, [], ['web/sites', 'web/core'])).toEqual([
      'web/core',
    ]);
  });

  it('preserves root-file and deeper exclusions missing from the rendered tree', () => {
    expect(preserveUnseenScopeExclusions(tree, [], ['.', 'web/sites/default/files'])).toEqual([
      '.',
      'web/sites/default/files',
    ]);
  });

  it('retains all saved exclusions for an empty tree and deduplicates them', () => {
    expect(preserveUnseenScopeExclusions([], ['vendor'], ['vendor', 'web/core'])).toEqual([
      'vendor',
      'web/core',
    ]);
  });
});
