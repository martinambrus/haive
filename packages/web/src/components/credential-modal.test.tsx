import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CredentialModal } from './credential-modal';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const forge = vi.hoisted(() => ({ hosts: undefined as string[] | undefined }));
vi.mock('@haive/shared/forge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/forge')>();
  return {
    ...actual,
    get AUTO_DETECT_HOSTS() {
      return forge.hosts ?? actual.AUTO_DETECT_HOSTS;
    },
  };
});

const render = () => {
  const html = renderToStaticMarkup(
    <CredentialModal open onClose={() => {}} onCreated={() => {}} />,
  );
  // React writes an apostrophe in text as &#x27;.
  return html.replaceAll('&#x27;', "'");
};

describe('CredentialModal provider help', () => {
  it('lists the hosts auto-detect covers', () => {
    expect(render()).toContain(
      'Auto-detect covers github.com, gitlab.com, codeberg.org and bitbucket.org; pick the software',
    );
  });

  it('builds that list from the shared forge module instead of spelling it', () => {
    forge.hosts = ['git.one.test', 'git.two.test', 'git.three.test'];
    try {
      expect(render()).toContain(
        'Auto-detect covers git.one.test, git.two.test and git.three.test; pick the software',
      );
    } finally {
      forge.hosts = undefined;
    }
  });

  it('states the rule an API base override must meet', () => {
    expect(render()).toContain(
      "An API base override must be an https URL on the credential's host or on its forge's API host, with no user, query or fragment.",
    );
  });
});
