import { describe, expect, it } from 'vitest';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import {
  authMethodLabel,
  canClearGithubClient,
  categoryLabel,
  completionBody,
  connectChoices,
  describeGithubClientSource,
  disconnectNotice,
  enabledServing,
  isHttpsUrl,
  linkableCredentials,
  needsWriteReconnect,
  reconnectMethod,
  reconnectOffer,
  statusBadge,
  statusNote,
  type IntegrationConnection,
  type IntegrationProvider,
} from './integrations';

const connection = (over: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  id: 'conn-1',
  providerId: 'module.stub.vendor',
  accountLabel: 'ada@stub.test',
  authMethod: 'oauth2',
  grantedScopes: ['files.read'],
  status: 'connected',
  lastError: null,
  refreshRefusedAt: null,
  repoCredentialId: null,
  expiresAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

const provider = (over: Partial<IntegrationProvider> = {}): IntegrationProvider => ({
  id: 'module.stub.vendor',
  displayName: 'Stub Vendor',
  categories: ['file-storage'],
  selfHosted: false,
  enabled: true,
  writeEnabled: false,
  canWrite: true,
  writeScopes: { oauth2: ['files.write'], device: ['files.write'] },
  connect: ['oauth2', 'device'],
  ...over,
});

describe('statusBadge', () => {
  it('names each status the broker records and colours it by how well the connection works', () => {
    expect(statusBadge('connected')).toEqual({ label: 'Connected', variant: 'success' });
    expect(statusBadge('needs_reauth')).toEqual({
      label: 'Needs reconnecting',
      variant: 'warning',
    });
    expect(statusBadge('provider_unavailable')).toEqual({
      label: 'Provider unavailable',
      variant: 'warning',
    });
    expect(statusBadge('revoked')).toEqual({ label: 'Revoked', variant: 'error' });
  });

  it('shows a status it does not know as itself, never as working', () => {
    expect(statusBadge('suspended')).toEqual({ label: 'suspended', variant: 'default' });
    expect(statusBadge('constructor')).toEqual({ label: 'constructor', variant: 'default' });
  });
});

describe('statusNote', () => {
  it('is the last error, as words, while the status says the connection is not working', () => {
    expect(
      statusNote(connection({ status: 'needs_reauth', lastError: 'invalid_grant: token revoked' })),
    ).toBe('invalid_grant: token revoked');
    expect(statusNote(connection({ status: 'provider_unavailable', lastError: 'HTTP 503' }))).toBe(
      'HTTP 503',
    );
  });

  it('is the last error, as words, while a connected connection carries the refusal flag', () => {
    expect(
      statusNote(
        connection({
          status: 'connected',
          refreshRefusedAt: '2026-10-30T09:00:00.000Z',
          lastError: 'invalid_grant: refresh refused',
        }),
      ),
    ).toBe('invalid_grant: refresh refused');
  });

  it('ignores an error left over from an earlier failure while a connected connection has no flag', () => {
    expect(
      statusNote(connection({ status: 'connected', lastError: 'invalid_grant: token revoked' })),
    ).toBeNull();
  });

  it('reads a payload that omits the flag (an older api) as not flagged', () => {
    const older = { status: 'connected', lastError: 'invalid_grant: token revoked' };
    expect(statusNote(older as Parameters<typeof statusNote>[0])).toBeNull();
  });

  it('has nothing to add when a failed connection carries no error', () => {
    expect(statusNote(connection({ status: 'needs_reauth', lastError: null }))).toBeNull();
    expect(statusNote(connection({ status: 'needs_reauth', lastError: '  ' }))).toBeNull();
  });
});

describe('connectChoices', () => {
  it('offers the web sign-in before the device code, whatever order the api listed them in', () => {
    expect(connectChoices(['oauth2', 'device'])).toEqual(['oauth2', 'device']);
    expect(connectChoices(['device', 'oauth2'])).toEqual(['oauth2', 'device']);
  });

  it('offers only the method there is', () => {
    expect(connectChoices(['device'])).toEqual(['device']);
    expect(connectChoices(['oauth2'])).toEqual(['oauth2']);
    expect(connectChoices([])).toEqual([]);
  });

  it('leaves out a method this page cannot drive, and repeats', () => {
    expect(connectChoices(['token', 'device', 'sms', 'device'])).toEqual(['device']);
    expect(connectChoices(['token'])).toEqual([]);
  });

  it('puts the preferred method first when it is offered', () => {
    expect(connectChoices(['oauth2', 'device'], 'device')).toEqual(['device', 'oauth2']);
    expect(connectChoices(['oauth2'], 'device')).toEqual(['oauth2']);
  });
});

describe('reconnectMethod', () => {
  it('signs in again by the method the connection was made with', () => {
    expect(reconnectMethod(connection({ authMethod: 'device' }), ['oauth2', 'device'])).toBe(
      'device',
    );
    expect(reconnectMethod(connection({ authMethod: 'oauth2' }), ['oauth2', 'device'])).toBe(
      'oauth2',
    );
  });

  it('falls back to the method that is offered when its own no longer is', () => {
    expect(reconnectMethod(connection({ authMethod: 'device' }), ['oauth2'])).toBe('oauth2');
    expect(reconnectMethod(connection({ authMethod: 'token' }), ['device'])).toBe('device');
  });

  it('is none when no sign-in is offered', () => {
    expect(reconnectMethod(connection(), [])).toBeNull();
  });
});

describe('needsWriteReconnect', () => {
  const input = (
    over: Partial<Parameters<typeof needsWriteReconnect>[0]> = {},
  ): Parameters<typeof needsWriteReconnect>[0] => ({
    writeEnabled: true,
    connection: connection(),
    writeScopes: { oauth2: ['files.write'], device: ['files.write'] },
    ...over,
  });

  it('is true when the switch is on and the grant lacks the write scope', () => {
    expect(needsWriteReconnect(input())).toBe(true);
  });

  it('is false while the switch is off', () => {
    expect(needsWriteReconnect(input({ writeEnabled: false }))).toBe(false);
  });

  it('is false once the grant holds every write scope', () => {
    const granted = connection({ grantedScopes: ['files.read', 'files.write'] });
    expect(needsWriteReconnect(input({ connection: granted }))).toBe(false);
  });

  it('is true while the grant holds only some of several write scopes', () => {
    const writeScopes = { oauth2: ['drive.write', 'docs.write'] };
    const partly = connection({ grantedScopes: ['drive.write'] });
    expect(needsWriteReconnect(input({ connection: partly, writeScopes }))).toBe(true);
  });

  it('is false where write is the scope read already needs, as for GitHub', () => {
    const github = connection({ authMethod: 'device', grantedScopes: ['repo'] });
    expect(
      needsWriteReconnect(input({ connection: github, writeScopes: { device: ['repo'] } })),
    ).toBe(false);
  });

  it('is judged by the scopes of the method the connection signed in with', () => {
    const device = connection({ authMethod: 'device', grantedScopes: ['files.write'] });
    const writeScopes = { oauth2: ['files.write', 'files.admin'], device: ['files.write'] };
    expect(needsWriteReconnect(input({ connection: device, writeScopes }))).toBe(false);
  });

  it('is false for a connection that has no sign-in to repeat, as a Git credential has not', () => {
    const credential = connection({ authMethod: 'token', grantedScopes: [] });
    expect(needsWriteReconnect(input({ connection: credential }))).toBe(false);
    expect(needsWriteReconnect(input({ writeScopes: {} }))).toBe(false);
    expect(needsWriteReconnect(input({ writeScopes: { oauth2: [] } }))).toBe(false);
  });

  it('is false for a connection that is not connected, which is asked to sign in anyway', () => {
    expect(needsWriteReconnect(input({ connection: connection({ status: 'needs_reauth' }) }))).toBe(
      false,
    );
  });
});

describe('reconnectOffer', () => {
  it('offers a connection that needs it a reconnect by the method it signed in with', () => {
    const offer = reconnectOffer(
      connection({ status: 'needs_reauth', authMethod: 'device' }),
      provider(),
    );
    expect(offer).toEqual({ reason: 'needs_reauth', method: 'device' });
  });

  it('offers a healthy connection a reconnect only to grant the write access the switch asks for', () => {
    expect(reconnectOffer(connection(), provider({ writeEnabled: false }))).toBeNull();
    expect(reconnectOffer(connection(), provider({ writeEnabled: true }))).toEqual({
      reason: 'write_access',
      method: 'oauth2',
    });
  });

  it('keeps the offer, with no method, when the provider offers no sign-in now', () => {
    const offer = reconnectOffer(connection({ status: 'needs_reauth' }), provider({ connect: [] }));
    expect(offer).toEqual({ reason: 'needs_reauth', method: null });
  });

  it('cannot tell what a connection of an unlisted provider would need beyond its own status', () => {
    expect(reconnectOffer(connection(), undefined)).toBeNull();
    expect(reconnectOffer(connection({ status: 'needs_reauth' }), undefined)).toEqual({
      reason: 'needs_reauth',
      method: null,
    });
  });
});

describe('disconnectNotice', () => {
  const account = { accountLabel: 'octocat' };

  it('says the Git credential stays when the connection pointed at one', () => {
    const notice = disconnectNotice({ ...account, repoCredentialId: 'cred-1' }, 'GitHub', 'n/a');
    expect(notice).toBe('octocat disconnected. The Git credential stays.');
  });

  it('says whether the provider was asked to revoke the token it issued', () => {
    const owned = { ...account, repoCredentialId: null };
    expect(disconnectNotice(owned, 'Stub Vendor', 'yes')).toContain('revoked at Stub Vendor');
    expect(disconnectNotice(owned, 'Stub Vendor', 'no')).toContain('could not be asked to revoke');
    expect(disconnectNotice(owned, 'Stub Vendor', 'n/a')).toBe('octocat disconnected.');
  });
});

describe('canClearGithubClient', () => {
  it('lets a user clear only the client id they saved themselves', () => {
    expect(canClearGithubClient('user')).toBe(true);
  });

  it('hides Clear while the environment or an administrator is what configures GitHub', () => {
    expect(canClearGithubClient('env')).toBe(false);
    expect(canClearGithubClient('admin')).toBe(false);
  });

  it('has nothing to clear when no client is configured', () => {
    expect(canClearGithubClient(null)).toBe(false);
  });
});

describe('describeGithubClientSource', () => {
  it('names where the client comes from', () => {
    expect(describeGithubClientSource('env')?.label).toBe('server environment');
    expect(describeGithubClientSource('admin')?.label).toBe('administrator');
    expect(describeGithubClientSource('user')?.label).toBe('your client ID');
  });

  it('says plainly that a client ID saved here does not apply while the environment supplies one', () => {
    expect(describeGithubClientSource('env')?.text).toContain('server environment');
    expect(describeGithubClientSource('env')?.text).toContain('not used');
  });

  it('has nothing to say when nothing is configured', () => {
    expect(describeGithubClientSource(null)).toBeNull();
  });
});

describe('linkableCredentials', () => {
  const credential = (over: Partial<Parameters<typeof linkableCredentials>[1][number]> = {}) => ({
    id: 'cred-1',
    label: 'Work',
    host: 'gitlab.com',
    provider: null,
    ...over,
  });

  it('offers the credentials that run the provider, by an explicit provider or by a known host', () => {
    const credentials = [
      credential({ id: 'a', host: 'gitlab.com' }),
      credential({ id: 'b', host: 'git.example.test', provider: 'gitlab' }),
      credential({ id: 'c', host: 'github.com' }),
      credential({ id: 'd', host: 'git.example.test' }),
    ];
    expect(linkableCredentials('gitlab', credentials, []).map((c) => c.id)).toEqual(['a', 'b']);
    expect(linkableCredentials('github', credentials, []).map((c) => c.id)).toEqual(['c']);
    expect(linkableCredentials('gitea', credentials, [])).toEqual([]);
  });

  it('reads a known host for the forge it runs, not only github.com', () => {
    const credentials = [
      credential({ id: 'a', host: 'codeberg.org' }),
      credential({ id: 'b', host: 'bitbucket.org' }),
    ];
    expect(linkableCredentials('gitea', credentials, []).map((c) => c.id)).toEqual(['a']);
    expect(linkableCredentials('bitbucket_cloud', credentials, []).map((c) => c.id)).toEqual(['b']);
  });

  it('leaves out a credential that already is a connection', () => {
    const credentials = [credential({ id: 'a' }), credential({ id: 'b' })];
    const taken = [connection({ providerId: 'gitlab', repoCredentialId: 'a' })];
    expect(linkableCredentials('gitlab', credentials, taken).map((c) => c.id)).toEqual(['b']);
  });

  it('offers nothing for a provider that is not a Git forge', () => {
    expect(linkableCredentials('module.stub.vendor', [credential()], [])).toEqual([]);
  });
});

describe('completionBody', () => {
  it('reads the state and the code the provider sent back', () => {
    expect(completionBody('?state=s1&code=c1', 'github')).toEqual({
      providerId: 'github',
      state: 's1',
      code: 'c1',
    });
  });

  it('reads a refusal by its error code and never forwards its description', () => {
    expect(
      completionBody('?state=s1&error=access_denied&error_description=User+said+no', 'github'),
    ).toEqual({ providerId: 'github', state: 's1', error: 'access_denied' });
  });

  it('lets the error win when both arrive', () => {
    expect(completionBody('?state=s1&code=c1&error=access_denied', 'github')).toEqual({
      providerId: 'github',
      state: 's1',
      error: 'access_denied',
    });
  });

  it('is nothing to complete without a state, or without a code or an error', () => {
    expect(completionBody('', 'github')).toBeNull();
    expect(completionBody('?code=c1', 'github')).toBeNull();
    expect(completionBody('?state=s1', 'github')).toBeNull();
    expect(completionBody('?state=&code=c1', 'github')).toBeNull();
    expect(completionBody('?state=s1&code=', 'github')).toBeNull();
  });
});

describe('isHttpsUrl', () => {
  it('accepts an https address only', () => {
    expect(isHttpsUrl('https://github.com/login/device')).toBe(true);
    expect(isHttpsUrl('http://github.com/login/device')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('github.com/login/device')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});

describe('authMethodLabel', () => {
  it('says how a connection signed in', () => {
    expect(authMethodLabel('oauth2')).toBe('Web sign-in');
    expect(authMethodLabel('device')).toBe('Device code');
    expect(authMethodLabel('token')).toBe('Git credential');
    expect(authMethodLabel('something-new')).toBe('something-new');
  });
});

describe('categoryLabel', () => {
  it('names every core category by its label', () => {
    for (const spec of CORE_INTEGRATION_CATEGORY_SPECS) {
      expect(categoryLabel(spec.id)).toBe(spec.label);
    }
    expect(categoryLabel('rich-documents')).toBe('Documents');
  });

  it('keeps the id of a category the core list does not name', () => {
    expect(categoryLabel('module.acme.crm')).toBe('module.acme.crm');
  });
});

describe('enabledServing', () => {
  const providers = [
    provider({ id: 'github', categories: ['forge'] }),
    provider({ id: 'gitea', categories: ['forge'], enabled: false }),
    provider({ id: 'module.stub.vendor', categories: ['file-storage', 'rich-documents'] }),
    provider({ id: 'gitlab', categories: ['forge'] }),
  ];

  it('keeps the enabled providers that serve the category, in the order given', () => {
    expect(enabledServing('forge', providers).map((p) => p.id)).toEqual(['github', 'gitlab']);
    expect(enabledServing('rich-documents', providers).map((p) => p.id)).toEqual([
      'module.stub.vendor',
    ]);
  });

  it('is empty for a category nothing enabled serves', () => {
    expect(enabledServing('mail', providers)).toEqual([]);
  });
});
