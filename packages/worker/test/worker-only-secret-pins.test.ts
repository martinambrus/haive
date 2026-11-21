import { describe, expect, it } from 'vitest';
import { WORKER_ONLY_SECRET_NAMES } from '../src/secrets/provider-secrets.js';
import { USAGE_PROVIDERS } from '../src/usage-window/fetchers/index.js';

describe('worker-only provider secret names', () => {
  it('include the secret of every usage fetcher that refreshes an OAuth grant', () => {
    const refreshed = Object.entries(USAGE_PROVIDERS).flatMap(([provider, config]) =>
      config?.token.kind === 'oauthRefresh'
        ? [{ provider, secretName: config.token.secretName }]
        : [],
    );
    // A refresh token is the one credential a container must never see, and the fetcher table is
    // where a new one gets declared: an empty list would pin nothing.
    expect(refreshed.length).toBeGreaterThan(0);
    expect(
      refreshed.filter((entry) => !WORKER_ONLY_SECRET_NAMES.has(entry.secretName)),
      'Add the secret name to WORKER_ONLY_SECRET_NAMES (worker/src/secrets/provider-secrets.ts): resolveProviderSecrets would otherwise put it in every container env.',
    ).toEqual([]);
  });
});
