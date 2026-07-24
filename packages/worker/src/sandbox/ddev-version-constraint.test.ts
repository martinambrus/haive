import { describe, expect, it } from 'vitest';
import { relaxExactDdevVersionConstraint } from './ddev-version-constraint.js';

const config = (constraintLine: string): string =>
  ['name: probe', 'type: php', 'php_version: "8.3"', constraintLine, 'docroot: web'].join('\n');

describe('relaxExactDdevVersionConstraint', () => {
  it('turns an exact pin into a range that keeps the floor and bounds the major', () => {
    const r = relaxExactDdevVersionConstraint(config(`ddev_version_constraint: 'v1.24.8'`));
    expect(r?.from).toBe('v1.24.8');
    expect(r?.to).toBe('>= v1.24.8 < v2.0.0');
    expect(r?.text).toContain('ddev_version_constraint: ">= v1.24.8 < v2.0.0"');
  });

  it('accepts a pin written without the v prefix', () => {
    const r = relaxExactDdevVersionConstraint(config('ddev_version_constraint: 1.25.2'));
    expect(r?.to).toBe('>= v1.25.2 < v2.0.0');
  });

  it('accepts double quotes and preserves indentation', () => {
    const r = relaxExactDdevVersionConstraint(`  ddev_version_constraint: "v1.25.2"\n`);
    expect(r?.text).toBe(`  ddev_version_constraint: ">= v1.25.2 < v2.0.0"\n`);
  });

  it('leaves the rest of the file untouched', () => {
    const before = config(`ddev_version_constraint: 'v1.25.2'`);
    const r = relaxExactDdevVersionConstraint(before);
    expect(r?.text.split('\n').length).toBe(before.split('\n').length);
    expect(r?.text).toContain('php_version: "8.3"');
    expect(r?.text).toContain('docroot: web');
  });

  it.each([
    '>= v1.25.2 < v1.26.0',
    '>= v1.25.2, < v1.26.0',
    '>=1.25.2 <1.26.0',
    '>= v1.25.2',
    '~> v1.25',
  ])('leaves a value that already carries a comparator alone: %s', (v) => {
    expect(relaxExactDdevVersionConstraint(config(`ddev_version_constraint: "${v}"`))).toBeNull();
  });

  it('returns null when the key is absent', () => {
    expect(relaxExactDdevVersionConstraint('name: probe\ntype: php\n')).toBeNull();
  });

  it('returns null for a value that is not a version at all', () => {
    expect(relaxExactDdevVersionConstraint(config('ddev_version_constraint: latest'))).toBeNull();
  });

  it('is idempotent — re-running on its own output changes nothing', () => {
    const once = relaxExactDdevVersionConstraint(config(`ddev_version_constraint: 'v1.25.2'`));
    expect(once).not.toBeNull();
    expect(relaxExactDdevVersionConstraint(once!.text)).toBeNull();
  });
});
