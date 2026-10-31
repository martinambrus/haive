import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IntegrationConnection } from '@/lib/integrations';
import { DisconnectDialog } from './disconnect-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const connection = (over: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  id: 'conn-1',
  providerId: 'github',
  accountLabel: 'octocat',
  authMethod: 'device',
  grantedScopes: ['repo'],
  status: 'connected',
  lastError: null,
  refreshRefusedAt: null,
  repoCredentialId: 'cred-1',
  expiresAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  updatedAt: '2026-10-14T10:00:00.000Z',
  ...over,
});

const render = (c: IntegrationConnection | null, credentialLabel: string | null = null) =>
  renderToStaticMarkup(
    <DisconnectDialog
      connection={c}
      providerName="GitHub"
      credentialLabel={credentialLabel}
      onClose={() => {}}
      onDisconnected={() => {}}
    />,
  );

describe('DisconnectDialog', () => {
  it('renders nothing while no connection is being disconnected', () => {
    expect(render(null)).toBe('');
  });

  it('says the Git credential stays when the connection points at one', () => {
    const html = render(connection(), 'GitHub OAuth (octocat)');
    expect(html).toContain('Only the connection goes');
    expect(html).toContain('The Git credential &quot;GitHub OAuth (octocat)&quot; stays');
    expect(html).toContain('the repositories that use it');
  });

  it('says the token is revoked where possible when the connection holds its own', () => {
    const html = render(connection({ repoCredentialId: null }));
    expect(html).toContain('to revoke its access token');
    expect(html).not.toContain('Git credential');
  });

  it('has a Cancel control and a Disconnect control', () => {
    const html = render(connection());
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*>Disconnect<\/button>/);
  });
});
