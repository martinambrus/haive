import { describe, expect, it } from 'vitest';
import { isDeniedPath, scopeInstructionLines } from './_scope.js';

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
