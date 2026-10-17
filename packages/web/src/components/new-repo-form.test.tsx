import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewRepoForm } from './new-repo-form';
import {
  createRenderer,
  findAll,
  fire,
  textOf,
  type Host,
  type Renderer,
} from '../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('./credential-modal', () => ({ CredentialModal: () => null }));
vi.mock('./filesystem-browser', () => ({ FilesystemBrowser: () => null }));
vi.mock('./repos/github-oauth-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repos/github-oauth-connect')>()),
  GithubOauthConnect: () => null,
}));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => structuredClone(body) });

let reposBody: unknown = { repos: [], truncated: false };

vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: '',
  api: {
    get: async (path: string) => {
      if (path === '/repo-credentials') {
        return { credentials: [{ id: 'c1', host: 'github.com', label: 'GitHub OAuth octo' }] };
      }
      if (path.startsWith('/github-oauth/repos?')) return reposBody;
      throw new Error(`not stubbed: ${path}`);
    },
    post: async () => {
      throw new Error('not stubbed: post');
    },
  },
}));

const NOTE =
  "Showing the 1000 most recently pushed repositories. The filter searches only these; enter any other repository's URL manually.";

beforeAll(() => vi.stubGlobal('fetch', () => Promise.resolve(ok({}))));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  reposBody = {
    repos: [
      {
        fullName: 'acme/one',
        cloneUrl: 'https://github.com/acme/one.git',
        defaultBranch: 'main',
        private: false,
      },
    ],
    truncated: false,
  };
});

async function mountOauth(): Promise<{ view: Renderer; root: () => Host }> {
  const view = createRenderer(() => <NewRepoForm />);
  for (let i = 0; i < 3; i += 1) await view.flush();
  const select = findAll(view.tree(), (h) => h.props.id === 'repo-source')[0]!;
  fire.type(select, 'github_oauth');
  for (let i = 0; i < 3; i += 1) await view.flush();
  return { view, root: view.tree };
}

describe('GitHub repository picker truncation note', () => {
  it('says the filter searches only the loaded repositories when the list is cut', async () => {
    reposBody = {
      repos: [
        {
          fullName: 'acme/one',
          cloneUrl: 'https://github.com/acme/one.git',
          defaultBranch: 'main',
          private: false,
        },
      ],
      truncated: true,
    };
    const { root } = await mountOauth();
    expect(textOf(root())).toContain(NOTE);
  });

  it('shows no truncation note when the list is complete', async () => {
    const { root } = await mountOauth();
    expect(textOf(root())).not.toContain('most recently pushed');
  });
});
