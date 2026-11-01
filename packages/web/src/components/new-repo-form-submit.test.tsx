import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewRepoForm } from './new-repo-form';
import {
  createRenderer,
  findAll,
  fire,
  isDisabled,
  textOf,
  type Renderer,
} from '../../test/render-tree';

// NewRepoForm once React has attached handleSubmit. The display name, the branch and the writable
// box are uncontrolled, so a submit posts what the form holds (new-repo-form-markup.test.tsx covers
// the server HTML), and the GitHub picker and the Source switch write the branch through its ref.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
const h = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
  get: vi.fn(),
  post: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
vi.mock('./credential-modal', () => ({ CredentialModal: () => null }));
vi.mock('./filesystem-browser', async () => {
  const { createElement } = await import('react');
  return {
    FilesystemBrowser: ({ onSelect }: { onSelect: (path: string) => void }) =>
      createElement(
        'button',
        { type: 'button', onClick: () => onSelect('/srv/app') },
        'Pick /srv/app',
      ),
  };
});
vi.mock('./repos/github-oauth-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repos/github-oauth-connect')>()),
  GithubOauthConnect: () => null,
}));
vi.mock('@/lib/api-client', () => ({ API_BASE_URL: '', api: { get: h.get, post: h.post } }));
// Node's FormData rejects a form argument, so the browser's `new FormData(form)` is stood in for by a
// subclass that takes the fields of the fake form `submit()` hands over.
const RealFormData = FormData;
vi.stubGlobal(
  'FormData',
  class extends RealFormData {
    constructor(form?: { fields: Record<string, string> }) {
      super();
      for (const [k, v] of Object.entries(form?.fields ?? {})) this.append(k, v);
    }
  },
);
vi.stubGlobal('fetch', h.fetch);
afterAll(() => {
  vi.unstubAllGlobals();
});

const REMOTE_URL = 'https://example.test/owner/repo.git';
const ACME = {
  fullName: 'acme/one',
  cloneUrl: 'https://github.com/acme/one.git',
  defaultBranch: 'main',
  private: false,
  pushedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  h.get.mockImplementation(async (path: string) => {
    if (path === '/repo-credentials') {
      return { credentials: [{ id: 'c1', host: 'github.com', label: 'GitHub OAuth octo' }] };
    }
    if (path.startsWith('/github-oauth/repos?')) return { repos: [ACME], truncated: false };
    throw new Error(`not stubbed: ${path}`);
  });
  h.post.mockResolvedValue({ repository: { id: 'r1' } });
});

const settle = async (view: Renderer) => {
  for (let i = 0; i < 3; i += 1) await view.flush();
};

const byId = (view: Renderer, id: string) =>
  findAll(view.tree(), (host) => host.props.id === id)[0]!;

async function mount(source?: string): Promise<Renderer> {
  const view = createRenderer(() => <NewRepoForm />);
  await settle(view);
  if (source) {
    fire.type(byId(view, 'repo-source'), source);
    await settle(view);
  }
  return view;
}

async function submit(view: Renderer, fields: Record<string, string>, preventDefault = vi.fn()) {
  const form = findAll(view.tree(), (host) => host.tag === 'form')[0]!;
  const onSubmit = form.props.onSubmit as (event: {
    preventDefault: () => void;
    currentTarget: { fields: Record<string, string> };
  }) => Promise<void>;
  await onSubmit({ preventDefault, currentTarget: { fields } });
  view.draw();
}

const submitButton = (view: Renderer) =>
  findAll(view.tree(), (host) => host.tag === 'button' && host.props.type === 'submit')[0]!;

const alerts = (view: Renderer) =>
  findAll(view.tree(), (host) => host.props.role === 'alert').map((alert) => textOf(alert));

describe('NewRepoForm after React has attached handleSubmit', () => {
  it('creates a blank project from the name and branch the form holds', async () => {
    const view = await mount('blank');
    const preventDefault = vi.fn();
    await submit(view, { repoName: 'proj', branch: 'dev' }, preventDefault);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/repos', {
      source: 'blank',
      name: 'proj',
      branch: 'dev',
    });
    expect(h.router.push).toHaveBeenCalledExactlyOnceWith('/repos');
  });

  const BOX: Array<[state: string, extra: Record<string, string>, writable: boolean]> = [
    ['ticked', { writable: 'on' }, true],
    ['left unticked', {}, false],
  ];
  it.each(BOX)(
    'posts the chosen directory with the writable box %s',
    async (_state, extra, writable) => {
      const view = await mount();
      const pick = findAll(
        view.tree(),
        (host) => host.tag === 'button' && textOf(host) === 'Pick /srv/app',
      )[0]!;
      fire.click(pick);
      view.draw();
      await submit(view, { repoName: 'x', branch: 'dev', ...extra });

      expect(h.post).toHaveBeenCalledExactlyOnceWith('/repos', {
        source: 'local_path',
        name: 'x',
        localPath: '/srv/app',
        writable,
        branch: 'dev',
      });
    },
  );

  it('posts the URL typed into its input with the name and branch the form holds', async () => {
    const view = await mount('git_https');
    fire.type(byId(view, 'repo-url'), REMOTE_URL);
    view.draw();
    await submit(view, { repoName: 'n', branch: 'dev' });

    expect(h.post).toHaveBeenCalledExactlyOnceWith('/repos', {
      source: 'git_https',
      name: 'n',
      remoteUrl: REMOTE_URL,
      branch: 'dev',
    });
  });

  it('uploads an archive under the name and branch the form holds', async () => {
    h.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ session: { id: 's1', bytesReceived: 0 } }),
    });
    const view = await mount('upload');
    const onFile = byId(view, 'repo-archive').props.onChange as (event: {
      target: { files: File[] };
    }) => void;
    onFile({ target: { files: [new File([], 'repo.zip')] } });
    view.draw();
    await submit(view, { repoName: 'up', branch: 'dev' });

    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      filename: 'repo.zip',
      name: 'up',
      branch: 'dev',
    });
    expect(h.router.push).toHaveBeenCalledExactlyOnceWith('/repos');
  });

  it('asks for a name before creating a blank project, and posts nothing', async () => {
    const view = await mount('blank');
    await submit(view, { repoName: '   ', branch: 'dev' });

    expect(alerts(view)).toEqual(['Give the new project a name']);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.router.push).not.toHaveBeenCalled();
    expect(isDisabled(submitButton(view))).toBe(false);
  });
});

describe('the branch field, written through its ref', () => {
  // The renderer draws no DOM, so the field a browser would attach is a bare object.
  function attachBranchField(view: Renderer, value: string): { value: string } {
    const ref = byId(view, 'repo-branch').props.ref as { current: unknown } | null | undefined;
    expect(ref, 'the branch input carries a ref').toBeTruthy();
    const field = { value };
    ref!.current = field;
    return field;
  }

  function pickRepo(view: Renderer): void {
    (byId(view, 'repo-picker').props.onFocus as () => void)();
    view.draw();
    const option = findAll(
      view.tree(),
      (host) => host.tag === 'button' && textOf(host).includes(ACME.fullName),
    )[0]!;
    fire.click(option);
    view.draw();
  }

  it("is filled with a picked GitHub repository's default branch when empty and untouched", async () => {
    const view = await mount('github_oauth');
    const field = attachBranchField(view, '');
    pickRepo(view);

    expect(field.value).toBe(ACME.defaultBranch);
  });

  it('keeps a branch the person already typed', async () => {
    const view = await mount('github_oauth');
    const field = attachBranchField(view, 'dev');
    pickRepo(view);

    expect(field.value).toBe('dev');
  });

  it('stays empty once the person has touched it', async () => {
    const view = await mount('github_oauth');
    const field = attachBranchField(view, '');
    fire.type(byId(view, 'repo-branch'), '');
    view.draw();
    pickRepo(view);

    expect(field.value).toBe('');
  });

  it('is emptied by a Source switch', async () => {
    const view = await mount('github_oauth');
    const field = attachBranchField(view, 'dev');
    fire.type(byId(view, 'repo-source'), 'git_https');
    view.draw();

    expect(field.value).toBe('');
  });
});

it.each(['git_https', 'local_path', 'upload', 'blank'])(
  'restores the GitHub picker and credential after switching through %s',
  async (otherSource) => {
    const view = await mount('github_oauth');
    expect(byId(view, 'repo-picker')).toBeDefined();
    fire.type(byId(view, 'repo-source'), otherSource);
    await settle(view);
    fire.type(byId(view, 'repo-source'), 'github_oauth');
    await settle(view);
    const picker = byId(view, 'repo-picker');
    expect(picker).toBeDefined();
    (picker.props.onFocus as () => void)();
    view.draw();
    fire.click(
      findAll(view.tree(), (host) => host.tag === 'button' && textOf(host) === ACME.fullName)[0]!,
    );
    view.draw();
    await submit(view, {});
    expect(h.post).toHaveBeenCalledExactlyOnceWith('/repos', {
      source: 'github_oauth',
      remoteUrl: ACME.cloneUrl,
      credentialsId: 'c1',
    });
    expect(alerts(view)).toEqual([]);
  },
);
