import { describe, expect, it } from 'vitest';
import { canUpgradeFrom, parseReleaseManifest, type ReleaseManifest } from './manifest.js';

const base = {
  manifestVersion: 1 as const,
  version: '0.3.0',
  builtAt: '2026-09-08T00:00:00.000Z',
  minFrom: '0.2.0',
  migrationHead: '0160_something',
};

describe('parseReleaseManifest', () => {
  it('fills the defaults a public release omits', () => {
    const m = parseReleaseManifest(base);
    expect(m.channel).toBe('public');
    expect(m.contracts).toBe(false);
    expect(m.images).toEqual({});
  });

  // The floor defaults PERMISSIVE, and this is a regression test, not a preference. A floor equal
  // to the release means only that release may upgrade to itself — every real upgrade refused. The
  // generator shipped that default once and a 0.1.0 install could not reach 0.2.0.
  it('defaults minFrom to a floor that does not block every upgrade', () => {
    const { minFrom, ...withoutFloor } = { ...base, minFrom: undefined };
    void minFrom;
    const m = parseReleaseManifest(withoutFloor);
    expect(m.minFrom).toBe('0.0.0');
    expect(canUpgradeFrom('0.1.0', m)).toBe(true);
    expect(canUpgradeFrom(m.version, m)).toBe(true);
  });

  it('keeps per-customer channel and digests', () => {
    const m = parseReleaseManifest({
      ...base,
      channel: 'customer-acme',
      images: { api: 'sha256:aaa', worker: 'sha256:bbb' },
    });
    expect(m.channel).toBe('customer-acme');
    expect(m.images.api).toBe('sha256:aaa');
    // A channel that builds locally names no web image, and that is legitimate.
    expect(m.images.web).toBeUndefined();
  });

  // The document is FETCHED and an upgrade acts on it, so a malformed one must not be guessed at.
  it('rejects a manifest it cannot read', () => {
    expect(() => parseReleaseManifest({ ...base, manifestVersion: 2 })).toThrow();
    expect(() => parseReleaseManifest({ ...base, minFrom: '' })).toThrow();
    expect(() => parseReleaseManifest({})).toThrow();
  });
});

describe('canUpgradeFrom', () => {
  const manifest = parseReleaseManifest(base) as ReleaseManifest;

  it('allows at or above the declared floor', () => {
    expect(canUpgradeFrom('0.2.0', manifest)).toBe(true);
    expect(canUpgradeFrom('0.2.1', manifest)).toBe(true);
    expect(canUpgradeFrom('1.0.0', manifest)).toBe(true);
  });

  it('refuses below it — that is the required stop this field exists to enforce', () => {
    expect(canUpgradeFrom('0.1.9', manifest)).toBe(false);
    expect(canUpgradeFrom('0.0.1', manifest)).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    expect(canUpgradeFrom('0.10.0', manifest)).toBe(true);
    expect(canUpgradeFrom('0.2', manifest)).toBe(true);
  });

  it('ignores a pre-release suffix', () => {
    expect(canUpgradeFrom('0.2.0-rc.1', manifest)).toBe(true);
  });

  // Refusing is the safe direction: the caller is about to migrate a database on this answer.
  it('refuses a version it cannot parse', () => {
    expect(canUpgradeFrom('unknown', manifest)).toBe(false);
    expect(canUpgradeFrom('', manifest)).toBe(false);
    expect(canUpgradeFrom('v-next', manifest)).toBe(false);
  });

  // Not a parse failure — `0.0.0-dev` parses as 0.0.0 and is refused for sorting BELOW every real
  // floor. That is the property the sentinel was chosen for: an unstamped build cannot upgrade
  // anything, without needing a special case anywhere.
  it('refuses the dev sentinel by ordering, not by exception', () => {
    expect(canUpgradeFrom('0.0.0-dev', manifest)).toBe(false);
    expect(canUpgradeFrom('0.0.0-dev', parseReleaseManifest({ ...base, minFrom: '0.0.1' }))).toBe(
      false,
    );
  });
});
