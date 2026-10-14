import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IntegrationConnection, IntegrationProvider } from '@/lib/integrations';
import { ConnectionRow } from './connection-row';

const connection = (over: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  id: 'conn-1',
  providerId: 'module.stub.vendor',
  accountLabel: 'ada@stub.test',
  authMethod: 'oauth2',
  grantedScopes: ['files.read'],
  status: 'connected',
  lastError: null,
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
  writeScopes: { oauth2: ['files.write'] },
  connect: ['oauth2'],
  ...over,
});

const render = (
  c: IntegrationConnection,
  p: IntegrationProvider | null = provider(),
  credentialLabel: string | null = null,
) =>
  renderToStaticMarkup(
    <ConnectionRow
      connection={c}
      provider={p ?? undefined}
      credentialLabel={credentialLabel}
      busy={false}
      onReconnect={() => {}}
      onDisconnect={() => {}}
    />,
  );

describe('ConnectionRow', () => {
  it('shows a healthy connection with its account, method and scopes, and no reconnect', () => {
    const html = render(connection());
    expect(html).toContain('Stub Vendor');
    expect(html).toContain('ada@stub.test');
    expect(html).toContain('>Connected<');
    expect(html).toContain('Web sign-in');
    expect(html).toContain('files.read');
    expect(html).not.toContain('>Reconnect<');
    expect(html).toMatch(/<button[^>]*>Disconnect<\/button>/);
  });

  it('keys the badge on the status column and leaves a stale last error out of a connected row', () => {
    const html = render(connection({ status: 'connected', lastError: 'invalid_grant: stale' }));
    expect(html).toContain('>Connected<');
    expect(html).not.toContain('invalid_grant: stale');
  });

  it('asks a connection that needs it to reconnect, with the error as words under the badge', () => {
    const html = render(
      connection({ status: 'needs_reauth', lastError: 'invalid_grant: token revoked' }),
    );
    expect(html).toContain('>Needs reconnecting<');
    expect(html).toContain('invalid_grant: token revoked');
    expect(html).toMatch(/<button[^>]*>Reconnect<\/button>/);
    expect(html).not.toContain('Reconnect to grant write access');
  });

  it('says a failed connection needs reconnecting even when it carries no error text', () => {
    const html = render(connection({ status: 'needs_reauth', lastError: null }));
    expect(html).toContain('>Needs reconnecting<');
    expect(html).toMatch(/<button[^>]*>Reconnect<\/button>/);
  });

  it('asks for a reconnect to grant write access when the switch is on and the grant lacks it', () => {
    const html = render(connection(), provider({ writeEnabled: true }));
    expect(html).toContain('Reconnect to grant write access');
    expect(html).toMatch(/<button[^>]*>Reconnect<\/button>/);
  });

  it('does not ask for it while the switch is off or once the grant holds the write scope', () => {
    expect(render(connection(), provider({ writeEnabled: false }))).not.toContain(
      'Reconnect to grant write access',
    );
    const granted = connection({ grantedScopes: ['files.read', 'files.write'] });
    expect(render(granted, provider({ writeEnabled: true }))).not.toContain(
      'Reconnect to grant write access',
    );
  });

  it('keeps the reconnect button but disables it when the provider offers no sign-in now', () => {
    const html = render(connection({ status: 'needs_reauth' }), provider({ connect: [] }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reconnect<\/button>/);
    expect(html).toContain('No sign-in is set up for Stub Vendor');
  });

  it('names the Git credential a forge connection points at', () => {
    const html = render(
      connection({ authMethod: 'device', repoCredentialId: 'cred-1' }),
      provider(),
      'GitHub OAuth (octocat)',
    );
    expect(html).toContain('Device code');
    expect(html).toContain('Uses the Git credential &quot;GitHub OAuth (octocat)&quot;.');
  });

  it('shows the provider id when the provider is no longer listed, and escapes the account as text', () => {
    const html = render(connection({ accountLabel: '<b>ada</b>' }), null);
    expect(html).toContain('module.stub.vendor');
    expect(html).toContain('&lt;b&gt;ada&lt;/b&gt;');
    expect(html).not.toContain('<b>ada</b>');
  });
});
