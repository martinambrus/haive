import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_INSTALL_METADATA } from '@haive/shared';
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

describe('npm version sources', () => {
  function stubNpm(payload: unknown) {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));
    vi.stubGlobal('fetch', fn as unknown as typeof fetch);
    return fn;
  }

  it('asks the registry for the abbreviated document', async () => {
    const fn = stubNpm({ versions: { '2.1.0': {} }, 'dist-tags': { latest: '2.1.0' } });
    await fetchVersionsFromSource({ kind: 'npm', package: '@anthropic-ai/claude-code' });
    const headers = fn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Accept).toMatch(/^application\/vnd\.npm\.install-v1\+json/);
  });

  it('drops every version with a prerelease part when the source takes releases only', async () => {
    stubNpm({
      versions: {
        '0.171.0': {},
        '0.171.0-linux-x64': {},
        '0.171.0-darwin-arm64': {},
        '0.170.0': {},
        '0.172.0-alpha.1': {},
      },
      'dist-tags': { latest: '0.171.0' },
    });
    const res = await fetchVersionsFromSource({
      kind: 'npm',
      package: '@openai/codex',
      releasesOnly: true,
    });
    expect(res).toEqual({ versions: ['0.171.0', '0.170.0'], latestVersion: '0.171.0' });
  });

  it('keeps hyphenated releases when the source does not take releases only', async () => {
    stubNpm({
      versions: { '0.0.1795147237-g4dbcdb': {}, '0.0.1795000000-gabc123': {} },
      'dist-tags': { latest: '0.0.1795147237-g4dbcdb' },
    });
    const res = await fetchVersionsFromSource({ kind: 'npm', package: '@sourcegraph/amp' });
    expect(res?.versions).toEqual(['0.0.1795147237-g4dbcdb', '0.0.1795000000-gabc123']);
  });

  it('lists the versions of the package each npm-installed CLI installs', () => {
    for (const meta of Object.values(CLI_INSTALL_METADATA)) {
      if (meta.install.kind !== 'npm') continue;
      expect(meta.versionSource).toMatchObject({ kind: 'npm', package: meta.install.package });
    }
  });
});

describe('registry version token boundaries', () => {
  it('refuses a hostile npm or PyPI latest token', async () => {
    for (const token of ['9.9.9$(id)', '1.2.3\n', '-latest']) {
      mockFetch({ versions: { '1.2.3': {} }, 'dist-tags': { latest: token } });
      await expect(fetchVersionsFromSource({ kind: 'npm', package: 'codex' })).rejects.toThrow(
        /version token/,
      );
      mockFetch({ releases: { '1.2.3': {} }, info: { version: token } });
      await expect(fetchPypiVersions('pyright')).rejects.toThrow(/version token/);
    }
  });
  it('drops hostile entries from version lists', async () => {
    mockFetch({
      versions: { '1.2.3': {}, '9.9.9$(id)': {}, '8.8.8\n': {} },
      'dist-tags': { latest: '1.2.3' },
    });
    expect(await fetchVersionsFromSource({ kind: 'npm', package: 'codex' })).toEqual({
      versions: ['1.2.3'],
      latestVersion: '1.2.3',
    });
  });
});
