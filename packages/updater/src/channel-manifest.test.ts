import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadManifest, resolveChannel } from './cli.js';
import * as dk from './docker.js';

const manifest = {
  manifestVersion: 1,
  version: '9.9.9',
  channel: 'acme',
  builtAt: '2026-11-05',
  migrationHead: '0221',
};
afterEach(() => vi.restoreAllMocks());

describe('channel manifest controls', () => {
  it('refuses --manifest and --manifest-image together before IO', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(dk, 'readReleaseManifestImage').mockResolvedValue(JSON.stringify(manifest));
    await expect(
      loadManifest({
        manifest: 'https://invalid/release.json',
        manifestImage: 'acme/release:9.9.9',
        channel: 'acme',
        version: '9.9.9',
      }),
    ).rejects.toThrow('mutually exclusive');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a wrong channel', async () => {
    vi.spyOn(dk, 'readReleaseManifestImage').mockResolvedValue(
      JSON.stringify({ ...manifest, channel: 'other' }),
    );
    await expect(
      loadManifest({ manifestImage: 'acme/release:9.9.9', channel: 'acme', version: '9.9.9' }),
    ).rejects.toThrow('channel');
  });
  it('refuses a wrong version', async () => {
    vi.spyOn(dk, 'readReleaseManifestImage').mockResolvedValue(
      JSON.stringify({ ...manifest, version: '8.8.8' }),
    );
    await expect(
      loadManifest({ manifestImage: 'acme/release:9.9.9', channel: 'acme', version: '9.9.9' }),
    ).rejects.toThrow('version');
  });
  it('never falls back to public on an unpullable manifest image', async () => {
    vi.spyOn(dk, 'readReleaseManifestImage').mockRejectedValue(new Error('pull denied'));
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(
      loadManifest({ manifestImage: 'acme/release:9.9.9', channel: 'acme', version: '9.9.9' }),
    ).rejects.toThrow('pull denied');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('parses the shared schema and accepts a matching manifest', async () => {
    vi.spyOn(dk, 'readReleaseManifestImage').mockResolvedValue(JSON.stringify(manifest));
    expect(
      await loadManifest({
        manifestImage: 'acme/release:9.9.9',
        channel: 'acme',
        version: '9.9.9',
      }),
    ).toMatchObject(manifest);
  });
  it('requires an explicit image target version and refuses URL fallback for channel installs', async () => {
    await expect(
      loadManifest({ manifestImage: 'acme/release:9.9.9', channel: 'acme' }),
    ).rejects.toThrow('--version');
    await expect(
      loadManifest({ manifest: 'https://invalid/release.json', channel: 'acme' }),
    ).rejects.toThrow('--manifest-image');
  });
  it('uses the install channel and fails closed on CLI disagreement', () => {
    expect(resolveChannel(undefined, 'acme')).toBe('acme');
    expect(resolveChannel('acme', 'acme')).toBe('acme');
    expect(resolveChannel(undefined, '')).toBe('public');
    expect(() => resolveChannel('other', 'acme')).toThrow('channel');
    expect(() => resolveChannel('acme', '')).toThrow('channel');
    expect(() => resolveChannel(undefined, '../bad')).toThrow('channel');
  });
  it('preserves the public URL manifest output', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ...manifest, channel: 'public' })),
    );
    expect(
      await loadManifest({ manifest: 'https://public/release.json', channel: 'public' }),
    ).toEqual({ ...manifest, channel: 'public', minFrom: '0.0.0', contracts: false, images: {} });
  });
});
