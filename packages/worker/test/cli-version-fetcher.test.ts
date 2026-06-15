import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGemVersions,
  fetchGithubReleases,
  fetchPypiVersions,
  fetchVersionsFromSource,
} from '../src/cli-versions/fetcher.js';

function mockFetch(payload: unknown): void {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPypiVersions', () => {
  it('uses info.version as latest and drops non-semver/prerelease releases', async () => {
    mockFetch({
      releases: { '1.1.380': [], '1.1.400': [], '1.0.0': [], '1.1.401rc1': [] },
      info: { version: '1.1.400' },
    });
    const res = await fetchPypiVersions('pyright');
    expect(res.latestVersion).toBe('1.1.400');
    expect(res.versions).toEqual(['1.1.400', '1.1.380', '1.0.0']);
  });
});

describe('fetchGemVersions', () => {
  it('filters prereleases and sorts descending', async () => {
    mockFetch([
      { number: '0.51.0', prerelease: false },
      { number: '0.52.0.pre', prerelease: true },
      { number: '0.50.0', prerelease: false },
    ]);
    const res = await fetchGemVersions('solargraph');
    expect(res.latestVersion).toBe('0.51.0');
    expect(res.versions).toEqual(['0.51.0', '0.50.0']);
  });
});

describe('fetchGithubReleases with tagPrefix (rtk vX.Y.Z)', () => {
  it("strips the 'v' prefix so versions are bare semver and prereleases drop", async () => {
    mockFetch([
      { tag_name: 'v0.37.2', prerelease: false, draft: false },
      { tag_name: 'v0.36.0', prerelease: false, draft: false },
      { tag_name: 'v0.38.0-rc1', prerelease: true, draft: false },
    ]);
    const res = await fetchGithubReleases('rtk-ai/rtk', 'v');
    expect(res.latestVersion).toBe('0.37.2');
    expect(res.versions).toEqual(['0.37.2', '0.36.0']);
  });
});

describe('fetchVersionsFromSource', () => {
  it('returns null for { kind: none }', async () => {
    expect(await fetchVersionsFromSource({ kind: 'none' })).toBeNull();
  });

  it('dispatches npm sources to the npm fetcher', async () => {
    mockFetch({ versions: { '2.8.6': {}, '2.8.5': {} }, 'dist-tags': { latest: '2.8.6' } });
    const res = await fetchVersionsFromSource({ kind: 'npm', package: 'intelephense' });
    expect(res?.latestVersion).toBe('2.8.6');
    expect(res?.versions).toEqual(['2.8.6', '2.8.5']);
  });
});
