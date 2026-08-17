import { describe, it, expect } from 'vitest';
import { CLI_CREDENTIAL_FILES } from './credential-files.js';
import { USAGE_PROVIDERS } from './fetchers/index.js';

describe('CLI_CREDENTIAL_FILES', () => {
  // The regression this registry was extracted for. grok has no usage-window endpoint, so
  // while the descriptors lived on USAGE_PROVIDERS it was absent, the task-end sync skipped
  // it, and every in-task refresh was dropped — leaving the user volume with a spent refresh
  // token until grok deleted auth.json outright. Membership here is about protecting the
  // credential, not about metering.
  it('covers grok even though it has no usage-window endpoint', () => {
    expect(CLI_CREDENTIAL_FILES.grok).toBeDefined();
    expect(USAGE_PROVIDERS.grok).toBeUndefined();
    expect(CLI_CREDENTIAL_FILES.grok?.authPathIdx).toBe(0); // ~/.grok
    expect(CLI_CREDENTIAL_FILES.grok?.relPath).toBe('auth.json');
  });

  // One source of truth: the poller and the sync must read the same bytes off the same
  // path, or a rotation is carried back from a file nobody meters (or vice versa).
  it.each(['codex', 'gemini'] as const)('shares the %s descriptor with USAGE_PROVIDERS', (name) => {
    const token = USAGE_PROVIDERS[name]?.token;
    expect(token?.kind).toBe('volumeJson');
    const file = CLI_CREDENTIAL_FILES[name];
    expect(file).toBeDefined();
    if (token?.kind !== 'volumeJson' || !file) throw new Error('unreachable');
    expect(token.authPathIdx).toBe(file.authPathIdx);
    expect(token.relPath).toBe(file.relPath);
  });
});

describe('grok extract', () => {
  const extract = (raw: string) => CLI_CREDENTIAL_FILES.grok!.extract(JSON.parse(raw));

  // grok keys the entry by "<oidc_issuer>::<oidc_client_id>", so there is no fixed path to
  // it, and it names the access token `key` rather than `access_token`.
  it('pulls the access token out of the dynamically-keyed real file shape', () => {
    const raw = JSON.stringify({
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: 'eyJhbGciOiJFUzI1NiJ9.payload.sig',
        auth_mode: 'oidc',
        refresh_token: 'rt',
        expires_at: '2026-08-17T12:21:40.847755288Z',
        oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      },
    });
    expect(extract(raw)).toEqual({ token: 'eyJhbGciOiJFUzI1NiJ9.payload.sig' });
  });

  it('skips entries with no key and takes the first that has one', () => {
    const raw = JSON.stringify({
      'https://sso.example.com::c1': { auth_mode: 'oidc' },
      'https://auth.x.ai::c2': { key: 'second' },
    });
    expect(extract(raw)).toEqual({ token: 'second' });
  });

  // A null token means "no evidence the credential changed", which makes shouldSyncAuthBack
  // skip. That is the safe direction: never clobber a login off a file we cannot read.
  it.each([
    ['an empty file', '{}'],
    ['a json array', '[]'],
    ['an entry with no key', '{"https://auth.x.ai::c":{"auth_mode":"oidc"}}'],
    ['an empty key', '{"https://auth.x.ai::c":{"key":""}}'],
    ['a non-object entry', '{"https://auth.x.ai::c":"nope"}'],
  ])('returns a null token for %s', (_label, raw) => {
    expect(extract(raw)).toEqual({ token: null });
  });
});

describe('codex / gemini extract (unchanged by the move)', () => {
  it('reads codex tokens.access_token and tokens.account_id', () => {
    const j = JSON.parse('{"tokens":{"access_token":"at","account_id":"acct"}}');
    expect(CLI_CREDENTIAL_FILES.codex!.extract(j)).toEqual({ token: 'at', accountId: 'acct' });
  });

  it('reads gemini access_token', () => {
    expect(CLI_CREDENTIAL_FILES.gemini!.extract(JSON.parse('{"access_token":"at"}'))).toEqual({
      token: 'at',
    });
  });
});
