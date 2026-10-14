import { forgeProviderSchema, type ForgeProviderName } from '../schemas/repos.js';

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
