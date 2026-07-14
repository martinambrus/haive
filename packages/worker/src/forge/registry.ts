import type { ForgeProviderName } from '@haive/shared';
import { BitbucketCloudForgeProvider } from './bitbucket-cloud.js';
import { BitbucketServerForgeProvider } from './bitbucket-server.js';
import { GiteaForgeProvider } from './gitea.js';
import { GithubForgeProvider } from './github.js';
import { GitlabForgeProvider } from './gitlab.js';
import type { ForgeProvider } from './types.js';

const providers = new Map<ForgeProviderName, ForgeProvider>();
for (const provider of [
  new GithubForgeProvider(),
  new GiteaForgeProvider(),
  new GitlabForgeProvider(),
  new BitbucketCloudForgeProvider(),
  new BitbucketServerForgeProvider(),
]) {
  providers.set(provider.name, provider);
}

export function resolveForgeProvider(name: ForgeProviderName): ForgeProvider {
  const provider = providers.get(name);
  if (!provider) throw new Error(`Unknown forge provider: ${name}`);
  return provider;
}

/** Narrow an arbitrary string (e.g. a stored credential.provider column) to a known
 *  forge provider name. */
export function isForgeProviderName(value: string | null | undefined): value is ForgeProviderName {
  return value != null && providers.has(value as ForgeProviderName);
}
