import { describe, expect, it } from 'vitest';
import {
  relaxCappedDdevConstraintForRunner,
  relaxExactDdevVersionConstraint,
} from './ddev-version-constraint.js';

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

  it.each(['= v1.25.2', '=v1.25.2', '== v1.25.2', '==1.25.2'])(
    'relaxes an exact pin whose equality is spelled out: %s',
    (v) => {
      const r = relaxExactDdevVersionConstraint(config(`ddev_version_constraint: '${v}'`));
      expect(r?.from).toBe(v);
      expect(r?.to).toBe('>= v1.25.2 < v2.0.0');
      expect(r?.text).toContain('ddev_version_constraint: ">= v1.25.2 < v2.0.0"');
    },
  );

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
    '<= v1.25.2',
    '!= v1.25.2',
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

describe('relaxCappedDdevConstraintForRunner', () => {
  it('widens a ceiling pinned below the runner, keeping the floor and bounding the major', () => {
    // The real production failure: agent capped `< v1.25.0`, runner is v1.25.3.
    const r = relaxCappedDdevConstraintForRunner(
      config(`ddev_version_constraint: ">= v1.24.10 < v1.25.0"`),
      'v1.25.3',
    );
    expect(r?.from).toBe('>= v1.24.10 < v1.25.0');
    expect(r?.to).toBe('>= v1.24.10 < v2.0.0');
    expect(r?.text).toContain('ddev_version_constraint: ">= v1.24.10 < v2.0.0"');
  });

  it.each([
    ['>= v1.24.10, < v1.25.0', 'comma variant'],
    ['>=1.24.10 <1.25.0', 'no v prefix'],
    ['> v1.24.10 < v1.25.0', 'strict floor'],
  ])('repairs the ceiling regardless of range spelling: %s', (v) => {
    const r = relaxCappedDdevConstraintForRunner(
      config(`ddev_version_constraint: "${v}"`),
      'v1.25.3',
    );
    expect(r?.to).toBe('>= v1.24.10 < v2.0.0');
  });

  it('preserves indentation and rewrites only the value', () => {
    const r = relaxCappedDdevConstraintForRunner(
      `  ddev_version_constraint: ">= v1.24.10 < v1.25.0"\n`,
      'v1.25.3',
    );
    expect(r?.text).toBe(`  ddev_version_constraint: ">= v1.24.10 < v2.0.0"\n`);
  });

  it('refuses when the runner is below the floor (wants a newer DDEV than exists)', () => {
    expect(
      relaxCappedDdevConstraintForRunner(
        config(`ddev_version_constraint: ">= v1.30.0 < v1.31.0"`),
        'v1.25.3',
      ),
    ).toBeNull();
  });

  it('refuses a ceiling-only value — no floor intent to preserve', () => {
    expect(
      relaxCappedDdevConstraintForRunner(config(`ddev_version_constraint: "< v1.25.0"`), 'v1.25.3'),
    ).toBeNull();
  });

  it('refuses an exact pin — that is relaxExactDdevVersionConstraint’s job', () => {
    expect(
      relaxCappedDdevConstraintForRunner(config(`ddev_version_constraint: "v1.25.2"`), 'v1.25.3'),
    ).toBeNull();
  });

  it('is idempotent — its own output already admits the runner', () => {
    const once = relaxCappedDdevConstraintForRunner(
      config(`ddev_version_constraint: ">= v1.24.10 < v1.25.0"`),
      'v1.25.3',
    );
    expect(once).not.toBeNull();
    expect(relaxCappedDdevConstraintForRunner(once!.text, 'v1.25.3')).toBeNull();
  });

  it('returns null when the runner version is unparseable', () => {
    expect(
      relaxCappedDdevConstraintForRunner(
        config(`ddev_version_constraint: ">= v1.24.10 < v1.25.0"`),
        'not-a-version',
      ),
    ).toBeNull();
  });

  it('returns null when the key is absent', () => {
    expect(relaxCappedDdevConstraintForRunner('name: probe\ntype: php\n', 'v1.25.3')).toBeNull();
  });
});
