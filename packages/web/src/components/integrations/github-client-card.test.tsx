import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GithubClientSource } from '@/lib/integrations';
import { GithubClientForm, type GithubClientStatus } from './github-client-card';

const render = (status: GithubClientStatus | null, clientId = '') =>
  renderToStaticMarkup(
    <GithubClientForm
      status={status}
      clientId={clientId}
      saving={false}
      error={null}
      success={null}
      onClientIdChange={() => {}}
      onSave={() => {}}
      onClear={() => {}}
    />,
  );

const configured = (source: GithubClientSource): GithubClientStatus => ({
  configured: true,
  source,
});

describe('GithubClientForm', () => {
  it('offers Clear for the client ID the user saved themselves', () => {
    const html = render(configured('user'));
    expect(html).toMatch(/<button[^>]*>Clear<\/button>/);
    expect(html).toContain('source: your client ID');
    expect(html).toContain('(saved — enter new value to replace)');
  });

  it('hides Clear while the server environment configures GitHub, and says so', () => {
    const html = render(configured('env'));
    expect(html).not.toContain('>Clear<');
    expect(html).toContain('source: server environment');
    expect(html).toContain('is not used while it is set');
    expect(html).not.toContain('(saved — enter new value to replace)');
  });

  it('hides Clear while an administrator configures GitHub, and says so', () => {
    const html = render(configured('admin'));
    expect(html).not.toContain('>Clear<');
    expect(html).toContain('source: administrator');
    expect(html).toContain('An administrator saved a GitHub OAuth client for everyone');
  });

  it('has nothing to clear and says not configured when no client is set', () => {
    const html = render({ configured: false, source: null });
    expect(html).not.toContain('>Clear<');
    expect(html).toContain('not configured');
    expect(html).not.toContain('source:');
  });

  it('shows loading, with nothing to clear, until the status arrives', () => {
    const html = render(null);
    expect(html).toContain('loading');
    expect(html).not.toContain('>Clear<');
  });

  it('keeps Save off until a client ID is typed, so an empty Save cannot clear one unseen', () => {
    expect(render(configured('env'))).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    expect(render(configured('env'), 'Ov23liabc')).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Save<\/button>/,
    );
  });
});
