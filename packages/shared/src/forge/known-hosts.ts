import { forgeProviderSchema, type ForgeProviderName } from '../schemas/repos.js';
import { isForgeProviderName } from './registry.js';

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

/** Host portion of a git remote (https, ssh:// or scp-style), provider-independent —
 *  used to infer the forge for a well-known public host before the provider is known. */
export function hostFromRemote(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).host;
    } catch {
      return '';
    }
  }
  return trimmed.match(/^(?:[^@]+@)?([^:/]+):/)?.[1] ?? '';
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
