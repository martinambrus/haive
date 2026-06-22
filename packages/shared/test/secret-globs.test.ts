import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_CARVEOUTS,
  DEFAULT_SECRET_DENY_GLOBS,
  SECRET_SCAN_IGNORE_DIRS,
  computeEffectiveSecretGlobs,
} from '../src/constants/index.js';

describe('computeEffectiveSecretGlobs', () => {
  it('returns the built-in deny + carve-out/ignore sets when no overrides', () => {
    const { deny, ignore } = computeEffectiveSecretGlobs({});
    expect(deny).toEqual([...DEFAULT_SECRET_DENY_GLOBS]);
    expect(ignore).toEqual([...DEFAULT_SECRET_CARVEOUTS, ...SECRET_SCAN_IGNORE_DIRS]);
    expect(deny).toContain('**/.env');
    // bare *.sql is intentionally NOT a default (would mask migrations)
    expect(deny).not.toContain('**/*.sql');
  });

  it('denyExtend adds globs and dedupes against defaults', () => {
    const { deny } = computeEffectiveSecretGlobs({ denyExtend: ['**/*.sql', '**/.env'] });
    expect(deny).toContain('**/*.sql');
    expect(deny.filter((g) => g === '**/.env')).toHaveLength(1);
  });

  it('allow is added to the ignore set', () => {
    const { ignore } = computeEffectiveSecretGlobs({ allow: ['**/keep.env'] });
    expect(ignore).toContain('**/keep.env');
  });

  it('tolerates null/undefined overrides', () => {
    const { deny, ignore } = computeEffectiveSecretGlobs({ allow: null, denyExtend: null });
    expect(deny.length).toBeGreaterThan(0);
    expect(ignore.length).toBeGreaterThan(0);
  });
});
