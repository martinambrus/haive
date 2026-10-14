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

describe('github sign-in methods', () => {
  const github = CORE_FORGE_PROVIDER_SPECS.find((s) => s.id === 'github')!;
  const userInfo = { url: 'https://api.github.com/user', idPointer: '/id', labelPointer: '/login' };

  it('reads the account from api.github.com/user on the device flow', () => {
    expect(github.auth.find((a) => a.kind === 'device')).toEqual({
      kind: 'device',
      deviceCodeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: { read: ['repo'], write: ['repo'] },
      userInfo,
    });
  });

  it('declares the web flow with PKCE, a preregistered client and no revoke url', () => {
    expect(github.auth.find((a) => a.kind === 'oauth2')).toEqual({
      kind: 'oauth2',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: { read: ['repo'], write: ['repo'] },
      pkce: true,
      clientRegistration: ['preregistered'],
      userInfo,
    });
  });

  it('keeps the token method first and gives no other forge an oauth2 method', () => {
    expect(github.auth[0]?.kind).toBe('token');
    const withOauth = CORE_FORGE_PROVIDER_SPECS.filter((s) =>
      s.auth.some((a) => a.kind === 'oauth2'),
    ).map((s) => s.id);
    expect(withOauth).toEqual(['github']);
  });
});
