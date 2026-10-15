import { forgeProviderSchema, type ForgeProviderName } from '../schemas/repos.js';
import { isForgeProviderName } from './registry.js';
import { ForgeError } from './types.js';

/** Public hosts whose forge is unambiguous; a self-hosted host's name cannot reveal its forge. */
const KNOWN_HOST_PROVIDERS = new Map<string, ForgeProviderName>([
  ['github.com', 'github'],
  ['gitlab.com', 'gitlab'],
  ['codeberg.org', 'gitea'],
  ['bitbucket.org', 'bitbucket_cloud'],
]);

/** The forge a well-known public host runs, or null for a self-hosted / unknown host. */
export function inferForgeProviderFromHost(host: string): ForgeProviderName | null {
  return KNOWN_HOST_PROVIDERS.get(host.trim().toLowerCase()) ?? null;
}

/** The credential's explicit provider, else the forge its host runs; null for a self-hosted host with none. */
export function credentialForgeProvider(
  provider: string | null | undefined,
  host: string,
): ForgeProviderName | null {
  const explicit = forgeProviderSchema.safeParse(provider);
  return explicit.success ? explicit.data : inferForgeProviderFromHost(host);
}

/** Only an http(s) port is the forge's own; an ssh or git remote's port belongs to that transport. */
function hostOf(url: URL): string {
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : url.hostname;
}

/** Host portion of a git remote (https, ssh:// or scp-style), provider-independent —
 *  used to infer the forge for a well-known public host before the provider is known. */
export function hostFromRemote(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return hostOf(new URL(trimmed));
    } catch {
      return '';
    }
  }
  return trimmed.match(/^(?:[^@]+@)?([^:/]+):/)?.[1] ?? '';
}

/** Parse a git remote URL (https, ssh:// or scp-style git@host:owner/repo) into
 *  { host, owner, repo }. owner is everything between the host and the final path
 *  segment, so a GitLab subgroup path (group/subgroup/project) resolves to
 *  owner=group/subgroup, repo=project. Bitbucket Server clone URLs put the repo under
 *  /scm/{projectKey}/{slug}.git — the /scm prefix is stripped so owner=projectKey. */
export function parseRemote(
  remoteUrl: string,
  provider: ForgeProviderName,
): { host: string; owner: string; repo: string } {
  const trimmed = remoteUrl.trim();
  let host: string;
  let rawPath: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new ForgeError(`Cannot parse remote URL: ${remoteUrl}`);
    }
    host = hostOf(u);
    rawPath = u.pathname;
  } else {
    // scp-like: [user@]host:owner/repo(.git)
    const m = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
    if (!m || !m[1] || !m[2]) throw new ForgeError(`Cannot parse remote URL: ${remoteUrl}`);
    host = m[1];
    rawPath = `/${m[2]}`;
  }

  let segments = rawPath
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);

  if (provider === 'bitbucket_server' && segments[0] === 'scm') {
    segments = segments.slice(1);
  }

  const repo = segments[segments.length - 1];
  const ownerSegments = segments.slice(0, -1);
  if (!repo || ownerSegments.length === 0) {
    throw new ForgeError(`Remote URL has no owner/repo path: ${remoteUrl}`);
  }
  const owner = ownerSegments.join('/');
  return { host, owner, repo };
}

/** Whether a stored credential can open a PR for this repo. The repo's forge is fixed by
 *  its origin URL; a credential is usable when its forge (explicit provider, else inferred
 *  from the credential's host) matches the repo's. For a self-hosted origin whose forge
 *  can't be inferred from the host, require a host match plus an explicit provider (which
 *  resolveForgeContext needs anyway). This keeps a GitHub credential out of a GitLab repo's
 *  picker while letting an "auto-detect" credential on a well-known host through. */
export function credentialUsableForPr(
  c: { provider: string | null; host: string },
  originUrl: string | null,
): boolean {
  if (!originUrl) return false;
  const originHost = hostFromRemote(originUrl);
  const repoForge = inferForgeProviderFromHost(originHost);
  const credForge = credentialForgeProvider(c.provider, c.host);
  if (repoForge) return credForge === repoForge;
  return c.host === originHost && isForgeProviderName(c.provider);
}
