import { describe, expect, it } from 'vitest';
import { parseReleaseManifest } from '@haive/shared/release';
import { compareVersions, preflight, type PreflightInput } from './preflight.js';

const target = parseReleaseManifest({
  manifestVersion: 1,
  version: '0.2.0',
  builtAt: '2026-09-08T00:00:00.000Z',
  minFrom: '0.1.0',
  migrationHead: '0160_x',
});

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    currentVersion: '0.1.0',
    target,
    localImages: ['haive-api:0.1.0', 'haive-worker:0.1.0', 'haive-web:0.1.0'],
    currentImages: ['haive-api:0.1.0', 'haive-worker:0.1.0', 'haive-web:0.1.0'],
    freeBytes: 50e9,
    snapshotBytes: 2e9,
    ...over,
  };
}

describe('preflight', () => {
  it('passes a legal upgrade', () => {
    expect(preflight(input())).toEqual({ ok: true });
  });

  // Re-running must be safe: this is the reflex that follows a window nobody is sure finished.
  it('refuses the same version as a no-op rather than an error condition', () => {
    const r = preflight(input({ currentVersion: '0.2.0' }));
    expect(r.refusal).toBe('same-version');
    expect(r.message).toMatch(/nothing to do/);
  });

  // A release that contracted the schema cannot be un-run, and old code on a newer schema is
  // undefined rather than slow.
  it('refuses a downgrade and names the snapshot as the way back', () => {
    const r = preflight(input({ currentVersion: '0.3.0' }));
    expect(r.refusal).toBe('downgrade');
    expect(r.message).toMatch(/snapshot/);
  });

  // Refusing is not enough on its own — the message must say which stop is required, or the
  // operator is left reconstructing the path from release notes.
  it('refuses a jump below minFrom and NAMES the required stop', () => {
    const r = preflight(input({ currentVersion: '0.0.9' }));
    expect(r.refusal).toBe('illegal-jump');
    expect(r.message).toContain('0.1.0');
  });

  // An upgrade that cannot roll back is not an upgrade, and `docker image prune` removes the
  // rollback target silently.
  it('refuses when the images a rollback would need are gone', () => {
    const r = preflight(input({ localImages: ['haive-api:0.1.0'] }));
    expect(r.refusal).toBe('rollback-images-missing');
    expect(r.message).toContain('haive-worker:0.1.0');
    expect(r.message).toContain('haive-web:0.1.0');
  });

  it('refuses when the snapshot would not fit', () => {
    expect(preflight(input({ freeBytes: 1e9, snapshotBytes: 9e9 })).refusal).toBe(
      'insufficient-disk',
    );
  });

  // Ordering matters: a downgrade request with missing images should report the DOWNGRADE, which
  // is the operator's actual mistake, not a disk or image detail downstream of it.
  it('reports the most fundamental refusal first', () => {
    const r = preflight(input({ currentVersion: '0.9.0', localImages: [], freeBytes: 0 }));
    expect(r.refusal).toBe('downgrade');
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1);
  });

  it('ignores a pre-release suffix', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(0);
  });

  it('returns null rather than guessing at an unparseable version', () => {
    expect(compareVersions('unknown', '0.1.0')).toBeNull();
  });
});
