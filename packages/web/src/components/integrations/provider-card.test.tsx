import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitCredentialRow, IntegrationProvider } from '@/lib/integrations';
import { ProviderCard } from './provider-card';

const provider = (over: Partial<IntegrationProvider> = {}): IntegrationProvider => ({
  id: 'gitlab',
  displayName: 'GitLab',
  categories: ['forge'],
  selfHosted: true,
  enabled: true,
  writeEnabled: false,
  canWrite: true,
  writeScopes: {},
  connect: [],
  ...over,
});

const credential: GitCredentialRow = { id: 'cred-1', label: 'Work GitLab', host: 'gitlab.com' };

const render = (p: IntegrationProvider, linkable: GitCredentialRow[] = []) =>
  renderToStaticMarkup(
    <ProviderCard
      provider={p}
      linkable={linkable}
      busy={false}
      onConnect={() => {}}
      onWriteSwitch={() => {}}
      onLink={() => {}}
    />,
  );

describe('ProviderCard', () => {
  it('shows one write switch, off by default, for a provider that can write', () => {
    const html = render(provider());
    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain('Allow write access');
    expect(html).not.toMatch(/checked=""/);
    expect(render(provider({ writeEnabled: true }))).toMatch(/checked=""/);
  });

  it('shows no write switch for a provider with nothing to write', () => {
    expect(render(provider({ canWrite: false }))).not.toContain('type="checkbox"');
  });

  it('offers the web sign-in before the device code, each as its own button', () => {
    const html = render(
      provider({ id: 'github', displayName: 'GitHub', connect: ['device', 'oauth2'] }),
    );
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toEqual(['Sign in with GitHub', 'Sign in with GitHub using a device code']);
  });

  it('points a forge with no sign-in at Git Credentials', () => {
    const html = render(provider());
    expect(html).toContain('connects through a Git credential');
    expect(html).toContain('href="/settings/credentials"');
    expect(html).not.toMatch(/<button[^>]*>Sign in/);
  });

  it('points GitHub with no OAuth client at the client card', () => {
    const html = render(provider({ id: 'github', displayName: 'GitHub' }));
    expect(html).toContain('needs an OAuth client ID');
  });

  it('lists each saved Git credential that can be used as a connection', () => {
    const html = render(provider(), [credential]);
    expect(html).toContain('Use a saved Git credential');
    expect(html).toContain('Work GitLab');
    expect(html).toContain('gitlab.com');
    expect(html).toMatch(/<button[^>]*>Use as connection<\/button>/);
  });

  it('shows no list at all when there is no credential to offer', () => {
    const html = render(provider());
    expect(html).not.toContain('Use a saved Git credential');
    expect(html).not.toContain('Use as connection');
  });
});
