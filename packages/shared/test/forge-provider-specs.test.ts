import { describe, expect, it } from 'vitest';
import { integrationProviderSpecSchema } from '../src/modularity/index.js';
import { CORE_FORGE_PROVIDER_SPECS } from '../src/forge/provider-specs.js';

const SELF_HOSTED = ['gitea', 'gitlab', 'bitbucket_server'];

describe('CORE_FORGE_PROVIDER_SPECS', () => {
  it('describes the five forges in order', () => {
    expect(CORE_FORGE_PROVIDER_SPECS.map((s) => s.id)).toEqual([
      'github',
      'gitea',
      'gitlab',
      'bitbucket_cloud',
      'bitbucket_server',
    ]);
  });

  it.each(CORE_FORGE_PROVIDER_SPECS.map((s) => [s.id, s] as const))(
    '%s parses against the provider contract',
    (id, spec) => {
      expect(integrationProviderSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec.categories).toEqual(['forge']);
      expect(spec.selfHosted).toBe(SELF_HOSTED.includes(id));
      expect(spec.auth.some((a) => a.kind === 'token')).toBe(true);
      expect(spec.auth.some((a) => a.kind === 'device')).toBe(id === 'github');
      const access = Object.fromEntries((spec.operations ?? []).map((o) => [o.opId, o.access]));
      expect(access).toEqual({ open_pull_request: 'write', get_pull_request_state: 'read' });
    },
  );
});
