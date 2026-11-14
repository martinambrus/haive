import { describe, expect, it } from 'vitest';
import {
  canUpgradeFrom,
  parseReleaseManifest,
  releaseManifestSchema,
  type ReleaseManifest,
} from './manifest.js';

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

  it('control: accepts and round-trips the optional builder image', () => {
    const builder = `127.0.0.1:5000/haive-customer-builder@sha256:${'a'.repeat(64)}`;
    const m = parseReleaseManifest({ ...base, images: { builder } });
    expect(m.images.builder).toBe(builder);
    expect(parseReleaseManifest(JSON.parse(JSON.stringify(m))).images.builder).toBe(builder);
    expect(() => parseReleaseManifest({ ...base, images: { builder: '' } })).toThrow();
    expect(() => parseReleaseManifest({ ...base, images: { builder: 42 } })).toThrow();
  });

  // The document is FETCHED and an upgrade acts on it, so a malformed one must not be guessed at.
  it('rejects a manifest it cannot read', () => {
    expect(() => parseReleaseManifest({ ...base, manifestVersion: 2 })).toThrow();
    expect(() => parseReleaseManifest({ ...base, minFrom: '' })).toThrow();
    expect(() => parseReleaseManifest({})).toThrow();
  });
});

describe('release bundle', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const bundle = {
    files: { 'docker-compose.yml': digest, 'docker-compose.run.yml': digest },
    env: [
      { key: 'MAILPIT_UI_PASSWORD', generate: 'hex', bytes: 24 },
      { key: 'POSTGRES_PASSWORD', generate: 'never' },
    ],
    known: [{ 'docker-compose.yml': digest }],
  };
  const parse = (value: unknown) => parseReleaseManifest({ ...base, bundle: value });

  it('round-trips the optional bundle without changing manifestVersion', () => {
    const manifest = parse(bundle);
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.bundle).toEqual(bundle);
    expect(parseReleaseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(parseReleaseManifest(base)).not.toHaveProperty('bundle');
  });

  it('accepts any subset of the four allowed files, including historical missing overlays', () => {
    const files = Object.fromEntries(
      [
        'docker-compose.yml',
        'docker-compose.run.yml',
        'docker-compose.gpu.yml',
        'docker-compose.vulkan.yml',
      ].map((name) => [name, digest]),
    );
    expect(parse({ ...bundle, files }).bundle?.files).toEqual(files);
    expect(parse({ ...bundle, files: {}, known: [{}] }).bundle?.files).toEqual({});
  });

  it.each(['files', 'known'] as const)('rejects any other file name in %s', (field) => {
    for (const name of [
      'extra.yml',
      '../docker-compose.yml',
      '/docker-compose.yml',
      'bundle/docker-compose.yml',
    ]) {
      const files = { [name]: digest };
      expect(() => parse({ ...bundle, [field]: field === 'known' ? [files] : files })).toThrow();
    }
  });

  it.each(['files', 'known'] as const)('rejects malformed hashes in %s', (field) => {
    for (const hash of [
      'a'.repeat(64),
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(65)}`,
      digest + '\n',
    ]) {
      const files = { 'docker-compose.yml': hash };
      expect(() => parse({ ...bundle, [field]: field === 'known' ? [files] : files })).toThrow();
    }
  });

  it.each([16, 64])('accepts hex generation at the %i-byte boundary', (bytes) => {
    const env = [{ key: '_VALID_1', generate: 'hex', bytes }];
    expect(parse({ ...bundle, env }).bundle?.env).toEqual(env);
  });

  it.each([undefined, 15, 65, 16.5, '24'])('rejects invalid hex byte count %s', (bytes) => {
    expect(() => parse({ ...bundle, env: [{ key: 'KEY', generate: 'hex', bytes }] })).toThrow();
  });

  it('forbids bytes on never keys, including an explicitly undefined property', () => {
    for (const bytes of [24, undefined]) {
      expect(() => parse({ ...bundle, env: [{ key: 'KEY', generate: 'never', bytes }] })).toThrow();
    }
  });

  it('rejects invalid env names and generation modes', () => {
    for (const key of ['', '1KEY', 'WITH-DASH', 'WITH SPACE', 'KEY=VALUE', 'KEY\n']) {
      expect(() => parse({ ...bundle, env: [{ key, generate: 'never' }] })).toThrow();
    }
    expect(() => parse({ ...bundle, env: [{ key: 'KEY', generate: 'random' }] })).toThrow();
  });

  it('requires files, env and known whenever a bundle is present', () => {
    for (const field of ['files', 'env', 'known'] as const) {
      const { [field]: omitted, ...partial } = bundle;
      void omitted;
      expect(() => parse(partial)).toThrow();
    }
  });

  it('keeps the old z.object reader compatible by stripping the unknown bundle', () => {
    // omit recreates the previous reader: a plain z.object, whose default policy is strip.
    const oldReader = releaseManifestSchema.omit({ bundle: true });
    expect(oldReader.parse({ ...base, bundle })).toEqual(parseReleaseManifest(base));
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
