import { describe, expect, it } from 'vitest';
import {
  clientUpdate,
  enabledLabel,
  precedenceNote,
  secretPlaceholder,
  usesOauthClient,
  type AdminIntegrationProvider,
} from './admin-integrations';

const provider = (over: Partial<AdminIntegrationProvider> = {}): AdminIntegrationProvider => ({
  id: 'github',
  name: 'GitHub',
  categories: ['forge'],
  authKinds: ['token', 'device', 'oauth2'],
  enabled: true,
  rowExists: false,
  oauthClientId: null,
  hasClientSecret: false,
  redirectUri: 'http://localhost:3000/settings/integrations/callback/github',
  precedence: null,
  ...over,
});

describe('clientUpdate', () => {
  it('sends nothing when the form still shows what is saved', () => {
    expect(clientUpdate(provider(), { clientId: '', secret: '' })).toBeNull();
    expect(
      clientUpdate(provider({ oauthClientId: 'abc', hasClientSecret: true }), {
        clientId: 'abc',
        secret: '',
      }),
    ).toBeNull();
  });

  it('sends the client id alone when only it changed, trimmed', () => {
    expect(clientUpdate(provider(), { clientId: '  abc  ', secret: '' })).toEqual({
      oauthClientId: 'abc',
    });
    expect(
      clientUpdate(provider({ oauthClientId: 'abc' }), { clientId: ' abc ', secret: '' }),
    ).toBeNull();
  });

  it('sends an empty client id to clear a saved one', () => {
    expect(
      clientUpdate(provider({ oauthClientId: 'abc' }), { clientId: '  ', secret: '' }),
    ).toEqual({ oauthClientId: '' });
  });

  it('keeps the saved secret when the secret box is blank or only whitespace', () => {
    const saved = provider({ oauthClientId: 'abc', hasClientSecret: true });
    expect(clientUpdate(saved, { clientId: 'abc', secret: '' })).toBeNull();
    expect(clientUpdate(saved, { clientId: 'abc', secret: '   ' })).toBeNull();
    expect(clientUpdate(saved, { clientId: 'xyz', secret: '  ' })).toEqual({
      oauthClientId: 'xyz',
    });
  });

  it('sends a typed secret, trimmed, with or without a new client id', () => {
    const saved = provider({ oauthClientId: 'abc' });
    expect(clientUpdate(saved, { clientId: 'abc', secret: ' s3cret\n' })).toEqual({
      oauthClientSecret: 's3cret',
    });
    expect(clientUpdate(saved, { clientId: 'xyz', secret: 's3cret' })).toEqual({
      oauthClientId: 'xyz',
      oauthClientSecret: 's3cret',
    });
  });

  it('never carries the switch, which saves by itself', () => {
    expect(clientUpdate(provider(), { clientId: 'abc', secret: 's' })).not.toHaveProperty(
      'enabled',
    );
  });
});

describe('secretPlaceholder', () => {
  it('says a secret is saved and how to replace it, or that none is', () => {
    expect(secretPlaceholder(true)).toBe('saved — enter a new value to replace');
    expect(secretPlaceholder(false)).toBe('not set');
  });
});

describe('precedenceNote', () => {
  it('has nothing to say for a provider with no other source of its client', () => {
    expect(precedenceNote(null)).toBeNull();
  });

  it('says the environment variable wins once it is set', () => {
    const note = precedenceNote({ envVar: 'GITHUB_OAUTH_CLIENT_ID', envSet: true });
    expect(note?.tone).toBe('warning');
    expect(note?.text).toContain('GITHUB_OAUTH_CLIENT_ID');
    expect(note?.text).toContain('the environment variable wins');
  });

  it('gives the order, with the variable marked not set, while it is not', () => {
    const note = precedenceNote({ envVar: 'GITHUB_OAUTH_CLIENT_ID', envSet: false });
    expect(note?.tone).toBe('info');
    expect(note?.text).toContain('GITHUB_OAUTH_CLIENT_ID');
    expect(note?.text).toContain('not set');
    expect(note?.text).not.toContain('the environment variable wins');
  });
});

describe('enabledLabel', () => {
  it('says "by default" while no admin has saved the switch', () => {
    expect(enabledLabel(provider({ enabled: true, rowExists: false }))).toBe('Enabled by default');
    expect(enabledLabel(provider({ enabled: false, rowExists: false }))).toBe(
      'Disabled by default',
    );
  });

  it('says plainly what the admin saved', () => {
    expect(enabledLabel(provider({ enabled: true, rowExists: true }))).toBe('Enabled');
    expect(enabledLabel(provider({ enabled: false, rowExists: true }))).toBe('Disabled');
  });
});

describe('usesOauthClient', () => {
  it('is true for a provider with an OAuth or device sign-in', () => {
    expect(usesOauthClient(provider({ authKinds: ['token', 'device', 'oauth2'] }))).toBe(true);
    expect(usesOauthClient(provider({ authKinds: ['device'] }))).toBe(true);
  });

  it('is false for a token-only provider', () => {
    expect(usesOauthClient(provider({ authKinds: ['token'] }))).toBe(false);
  });
});
