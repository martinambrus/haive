import { logger } from '@haive/shared';

const log = logger.child({ module: 'cli-version-fetcher' });

const USER_AGENT = 'haive-cli-version-fetcher/1.0';

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchedVersions {
  versions: string[];
  latestVersion: string | null;
}

const MAX_VERSIONS_PER_PROVIDER = 200;

const UNSTABLE_SUFFIX_RE = /-(?:alpha|beta|rc|nightly|preview|dev|pre|canary|next)/i;

function filterStable(versions: string[]): string[] {
  return versions.filter((v) => !UNSTABLE_SUFFIX_RE.test(v));
}

function sortSemverDesc(versions: string[]): string[] {
  const parsed = versions
    .map((v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)(?:[-.+](.+))?$/.exec(v);
      if (!m) return null;
      return {
        v,
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        suffix: m[4] ?? '',
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  parsed.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    if (a.patch !== b.patch) return b.patch - a.patch;
    if (a.suffix === '' && b.suffix !== '') return -1;
    if (a.suffix !== '' && b.suffix === '') return 1;
    return b.suffix.localeCompare(a.suffix);
  });
  return parsed.map((p) => p.v);
}

export async function fetchNpmVersions(pkg: string): Promise<FetchedVersions> {
  const url = `https://registry.npmjs.org/${pkg}`;
  const body = (await fetchJson(url)) as {
    versions?: Record<string, unknown>;
    'dist-tags'?: Record<string, string>;
  };
  const all = Object.keys(body.versions ?? {});
  const stable = filterStable(all);
  const sorted = sortSemverDesc(stable).slice(0, MAX_VERSIONS_PER_PROVIDER);
  const distTags = body['dist-tags'] ?? {};
  const latest = distTags['stable'] ?? distTags['latest'] ?? sorted[0] ?? null;
  log.debug({ pkg, count: sorted.length, latest }, 'fetched npm versions');
  return { versions: sorted, latestVersion: latest };
}

export async function fetchGithubReleases(
  repo: string,
  tagPrefix?: string,
): Promise<FetchedVersions> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const body = (await fetchJson(url)) as Array<{
    tag_name: string;
    prerelease: boolean;
    draft: boolean;
  }>;
  const tags = body
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => r.tag_name)
    .map((t) => (tagPrefix && t.startsWith(tagPrefix) ? t.slice(tagPrefix.length) : t));
  const stable = filterStable(tags);
  const sorted = sortSemverDesc(stable);
  log.debug({ repo, count: sorted.length, latest: sorted[0] }, 'fetched github releases');
  return { versions: sorted, latestVersion: sorted[0] ?? null };
}
