import { describe, expect, it } from 'vitest';
import {
  cliAuthApiKeyVolumeName,
  cliAuthProviderVolumeName,
  cliAuthTaskVolumeName,
  cliAuthVolumeName,
  isCliAuthProviderVolume,
  isCliAuthTaskVolume,
  isCliAuthVolume,
  resolveCliAuthUserVolumeName,
  type CliAuthVolumeCtx,
} from '../src/cli-providers/auth-volume.js';

describe('cliAuthVolumeName (per-user shared)', () => {
  it('strips dashes and truncates user id to 12 chars', () => {
    expect(cliAuthVolumeName('aaaa-bbbb-cccc-dddd-eeeeffff', 'codex', 0)).toBe(
      'haive_cli_auth_aaaabbbbcccc_codex_0',
    );
  });

  it('encodes provider name and path index', () => {
    expect(cliAuthVolumeName('u1', 'gemini', 1)).toBe('haive_cli_auth_u1_gemini_1');
  });
});

describe('cliAuthProviderVolumeName (per-provider isolated)', () => {
  it('uses the _p_ segment so isolated volumes never collide with the per-user namespace', () => {
    const isolated = cliAuthProviderVolumeName('99b39acb-a6d1-440f-9c20-d1cb36cad964', 'gemini', 1);
    expect(isolated).toBe('haive_cli_auth_p_99b39acba6d1_gemini_1');
    expect(isolated).not.toEqual(cliAuthVolumeName('99b39acb-a6d1-440f', 'gemini', 1));
  });

  it('strips dashes from provider id and truncates to 12 chars', () => {
    expect(cliAuthProviderVolumeName('aaaa-bbbb-cccc-dddd', 'codex', 0)).toBe(
      'haive_cli_auth_p_aaaabbbbcccc_codex_0',
    );
  });

  it('two providers of the same CLI under the same user get distinct volume names', () => {
    const a = cliAuthProviderVolumeName('11111111-aaaa-bbbb', 'gemini', 0);
    const b = cliAuthProviderVolumeName('22222222-aaaa-bbbb', 'gemini', 0);
    expect(a).not.toBe(b);
  });
});

describe('resolveCliAuthUserVolumeName (auth-mode scoping)', () => {
  const ctx = (over: Partial<CliAuthVolumeCtx> = {}): CliAuthVolumeCtx => ({
    userId: 'aaaa-bbbb-cccc-dddd',
    providerId: '9999-8888-7777-6666',
    providerName: 'grok',
    authMode: 'subscription',
    isolateAuth: false,
    ...over,
  });

  it('THE BUG: the two modes of one user+CLI never share a volume', () => {
    // A subscription login wrote ~/.grok/auth.json into the shared volume; the API-key row
    // mounted the same volume, and grok prefers a session token over a key — so the row
    // configured for a key silently spent the subscription.
    const sub = resolveCliAuthUserVolumeName(ctx({ authMode: 'subscription' }), 0);
    const key = resolveCliAuthUserVolumeName(ctx({ authMode: 'api_key' }), 0);
    expect(sub).not.toBe(key);
  });

  it('COMPATIBILITY: a subscription row resolves byte-identically to the pre-change name', () => {
    // Pinned as a literal on purpose. This name addresses volumes that already exist on every
    // installation and hold the credential that actually authenticates; changing it logs every
    // user out of every CLI at once. A failure here is a migration, never a rename.
    expect(resolveCliAuthUserVolumeName(ctx({ authMode: 'subscription' }), 0)).toBe(
      'haive_cli_auth_aaaabbbbcccc_grok_0',
    );
    expect(resolveCliAuthUserVolumeName(ctx({ authMode: 'subscription' }), 0)).toBe(
      cliAuthVolumeName('aaaa-bbbb-cccc-dddd', 'grok', 0),
    );
  });

  it('an api_key row gets its own namespace', () => {
    expect(resolveCliAuthUserVolumeName(ctx({ authMode: 'api_key' }), 0)).toBe(
      'haive_cli_auth_aaaabbbbcccc_grok_k_0',
    );
    expect(resolveCliAuthUserVolumeName(ctx({ authMode: 'api_key' }), 0)).toBe(
      cliAuthApiKeyVolumeName('aaaa-bbbb-cccc-dddd', 'grok', 0),
    );
  });

  it('isolate_auth still wins and is unaffected by mode', () => {
    // Per-row already, so two rows cannot collide whatever their modes.
    const a = resolveCliAuthUserVolumeName(ctx({ isolateAuth: true, authMode: 'api_key' }), 0);
    const b = resolveCliAuthUserVolumeName(ctx({ isolateAuth: true, authMode: 'subscription' }), 0);
    expect(a).toBe(b);
    expect(a).toBe(cliAuthProviderVolumeName('9999-8888-7777-6666', 'grok', 0));
  });

  it('keeps the path index and provider name distinct per mode', () => {
    expect(resolveCliAuthUserVolumeName(ctx({ authMode: 'api_key' }), 1)).toBe(
      'haive_cli_auth_aaaabbbbcccc_grok_k_1',
    );
    expect(
      resolveCliAuthUserVolumeName(ctx({ authMode: 'api_key', providerName: 'codex' }), 0),
    ).toBe('haive_cli_auth_aaaabbbbcccc_codex_k_0');
  });

  it('an api_key volume is still recognised as a CLI auth volume, and is not task/provider scoped', () => {
    const name = cliAuthApiKeyVolumeName('u1', 'codex', 0);
    expect(isCliAuthVolume(name)).toBe(true);
    expect(isCliAuthTaskVolume(name)).toBe(false);
    expect(isCliAuthProviderVolume(name)).toBe(false);
  });
});

describe('isCliAuth* discriminators', () => {
  it('isCliAuthVolume matches every flavor (user / task / per-provider)', () => {
    expect(isCliAuthVolume(cliAuthVolumeName('u1', 'codex', 0))).toBe(true);
    expect(isCliAuthVolume(cliAuthTaskVolumeName('t1', 'codex', 0))).toBe(true);
    expect(isCliAuthVolume(cliAuthProviderVolumeName('p1', 'codex', 0))).toBe(true);
    expect(isCliAuthVolume('haive_repos')).toBe(false);
  });

  it('isCliAuthTaskVolume only matches the task namespace', () => {
    expect(isCliAuthTaskVolume(cliAuthTaskVolumeName('t1', 'codex', 0))).toBe(true);
    expect(isCliAuthTaskVolume(cliAuthVolumeName('u1', 'codex', 0))).toBe(false);
    expect(isCliAuthTaskVolume(cliAuthProviderVolumeName('p1', 'codex', 0))).toBe(false);
  });

  it('isCliAuthProviderVolume only matches the per-provider namespace', () => {
    expect(isCliAuthProviderVolume(cliAuthProviderVolumeName('p1', 'codex', 0))).toBe(true);
    expect(isCliAuthProviderVolume(cliAuthVolumeName('u1', 'codex', 0))).toBe(false);
    expect(isCliAuthProviderVolume(cliAuthTaskVolumeName('t1', 'codex', 0))).toBe(false);
  });
});
