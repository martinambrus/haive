import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@haive/shared';
import {
  collectDenyFrontier,
  isDeniedPath,
  noSubagentInstructionLines,
  scopeInstructionLines,
} from './_scope.js';

function node(path: string, children?: TreeNode[]): TreeNode {
  return { path, label: path.split('/').pop() ?? path, children } as TreeNode;
}

describe('noSubagentInstructionLines', () => {
  it('always returns a hard block naming the per-CLI spawn tools', () => {
    const text = noSubagentInstructionLines().join('\n');
    expect(text).toContain('HARD CONSTRAINT');
    // uniform wording covers every CLI family's spawn tool
    for (const tool of ['Task', 'Agent', 'spawn_agent', 'invoke_agent']) {
      expect(text).toContain(tool);
    }
    expect(text).toContain('Do NOT');
  });
});

describe('collectDenyFrontier', () => {
  // themes/{custom,contrib,gin}, libraries/{custom,contrib}, vendor(leaf)
  const tree: TreeNode[] = [
    node('themes', [node('themes/custom'), node('themes/contrib'), node('themes/gin')]),
    node('libraries', [node('libraries/custom'), node('libraries/contrib')]),
    node('vendor'),
  ];
  const frontier = (selected: string[]): string[] => {
    const out: string[] = [];
    collectDenyFrontier(tree, new Set(selected), out);
    return out.sort();
  };

  it('bottom-up: a subfolder-only tick is kept; siblings denied, parent NOT swallowed', () => {
    const deny = frontier(['themes/custom']);
    expect(deny).toContain('themes/contrib');
    expect(deny).toContain('themes/gin');
    expect(deny).not.toContain('themes'); // the bug: parent must NOT be denied wholesale
    expect(deny).not.toContain('themes/custom'); // kept in scope
    expect(deny).toContain('libraries');
    expect(deny).toContain('vendor');
  });

  it('parent ticked with one child unticked denies only that child', () => {
    expect(frontier(['themes', 'themes/custom', 'themes/gin'])).toEqual([
      'libraries',
      'themes/contrib',
      'vendor',
    ]);
  });

  it('nothing selected collapses each top-level subtree to one deny entry', () => {
    expect(frontier([])).toEqual(['libraries', 'themes', 'vendor']);
  });

  it('everything selected denies nothing', () => {
    expect(
      frontier([
        'themes',
        'themes/custom',
        'themes/contrib',
        'themes/gin',
        'libraries',
        'libraries/custom',
        'libraries/contrib',
        'vendor',
      ]),
    ).toEqual([]);
  });
});

describe('isDeniedPath', () => {
  const exclude = ['vendor', 'web/core', 'web/modules/contrib'];

  it('matches a path that IS an excluded directory', () => {
    expect(isDeniedPath('vendor', exclude)).toBe(true);
    expect(isDeniedPath('web/core', exclude)).toBe(true);
  });

  it('matches a path UNDER an excluded directory', () => {
    expect(isDeniedPath('web/core/lib/Drupal.php', exclude)).toBe(true);
    expect(isDeniedPath('web/modules/contrib/token/token.module', exclude)).toBe(true);
  });

  it('keeps in-scope custom code', () => {
    expect(isDeniedPath('web/modules/custom/foo/foo.module', exclude)).toBe(false);
    expect(isDeniedPath('src/index.ts', exclude)).toBe(false);
  });

  it('does not match on a shared name PREFIX (anchored, not substring)', () => {
    // `web/coreish` must NOT be denied by the `web/core` glob.
    expect(isDeniedPath('web/coreish/foo.php', exclude)).toBe(false);
    expect(isDeniedPath('vendored/x', exclude)).toBe(false);
  });

  it('an empty deny list denies nothing', () => {
    expect(isDeniedPath('anything/at/all', [])).toBe(false);
  });
});

describe('scopeInstructionLines', () => {
  it('returns [] when there is no deny list', () => {
    expect(scopeInstructionLines([])).toEqual([]);
  });

  it('lists each excluded directory as its own bullet', () => {
    const lines = scopeInstructionLines(['vendor', 'web/core']);
    expect(lines).toContain('- vendor');
    expect(lines).toContain('- web/core');
    // Has a header and closing note around the bullets.
    expect(lines[0]).toMatch(/Mining scope/i);
    expect(lines[lines.length - 1]).toBe('');
  });
});
