import { describe, expect, it } from 'vitest';
import { pickPreset, RANGE_PRESETS } from '../../src/web/lib/range-presets.js';

describe('pickPreset', () => {
  it('uses a valid URL preset over the setting', () => {
    expect(pickPreset('90d', '7d')).toBe('90d');
    expect(pickPreset('custom', '7d')).toBe('custom');
  });

  it('uses the setting when the URL names no valid preset', () => {
    expect(pickPreset(null, '7d')).toBe('7d');
    expect(pickPreset('bogus', '1y')).toBe('1y');
    expect(pickPreset('', 'all')).toBe('all');
  });

  it('falls back to 30d when the setting is invalid, custom or absent', () => {
    expect(pickPreset(null, 'bogus')).toBe('30d');
    expect(pickPreset(null, 'custom')).toBe('30d');
    expect(pickPreset(null, undefined)).toBe('30d');
    expect(pickPreset(null, 7)).toBe('30d');
  });

  it('accepts every non-custom preset as the setting', () => {
    for (const p of RANGE_PRESETS.filter((r) => r.id !== 'custom')) {
      expect(pickPreset(null, p.id)).toBe(p.id);
    }
  });
});
