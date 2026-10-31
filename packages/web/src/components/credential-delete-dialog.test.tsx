import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialDeleteDialog } from './credential-delete-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const backing = {
  id: 'cred-1',
  label: 'GitHub OAuth (octocat)',
  connection: { accountLabel: 'octocat', providerName: 'GitHub' },
};
const plain = { id: 'cred-2', label: 'Work PAT', connection: null };

const render = (credential: Parameters<typeof CredentialDeleteDialog>[0]['credential']) =>
  renderToStaticMarkup(
    <CredentialDeleteDialog credential={credential} onClose={() => {}} onDeleted={() => {}} />,
  );

describe('CredentialDeleteDialog', () => {
  it('renders nothing while no credential is being deleted', () => {
    expect(render(null)).toBe('');
  });

  it('names the connection the credential backs and says it is deleted with it', () => {
    const html = render(backing);
    expect(html).toContain('>Delete Git credential<');
    expect(html).toContain(
      'Delete the Git credential &quot;GitHub OAuth (octocat)&quot;? It is the connection to octocat on GitHub, so that connection is deleted with it. This cannot be undone.',
    );
  });

  it('does not mention a connection when the credential backs none', () => {
    for (const credential of [plain, { id: 'cred-3', label: 'Work PAT' }]) {
      const html = render(credential);
      expect(html).toContain(
        'Delete the Git credential &quot;Work PAT&quot;? This cannot be undone.',
      );
      expect(html).not.toContain('connection');
    }
  });

  it('has a Cancel control and a Delete control', () => {
    const html = render(plain);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*>Delete<\/button>/);
  });
});
