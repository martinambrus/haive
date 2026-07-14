import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitbucketCloudForgeProvider } from './bitbucket-cloud.js';
import { BitbucketServerForgeProvider } from './bitbucket-server.js';
import { GiteaForgeProvider } from './gitea.js';
import { GithubForgeProvider } from './github.js';
import { GitlabForgeProvider } from './gitlab.js';
import {
  credentialForgeProvider,
  hostFromRemote,
  inferForgeProviderFromHost,
  parseRemote,
} from './resolve-forge-context.js';
import { ForgeAuthError, type ForgeContext } from './types.js';

function ctx(over: Partial<ForgeContext> = {}): ForgeContext {
  return {
    provider: 'github',
    apiBase: 'https://api.github.com',
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
    token: 'tok',
    username: 'user',
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function lastCall(): {
  url: string;
  init: { method?: string; headers: Record<string, string>; body?: string };
} {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return { url: call[0] as string, init: call[1] as never };
}

const OPEN_INPUT = { head: 'feat', base: 'main', title: 'T', body: 'B' };

describe('github adapter', () => {
  it('opens a PR with Bearer auth and the shared body shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ number: 7, html_url: 'https://github.com/acme/app/pull/7' }, 201),
    );
    const res = await new GithubForgeProvider().openPullRequest(ctx(), OPEN_INPUT);
    expect(res).toEqual({ url: 'https://github.com/acme/app/pull/7', number: '7' });
    const { url, init } = lastCall();
    expect(url).toBe('https://api.github.com/repos/acme/app/pulls');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body ?? '')).toEqual({
      title: 'T',
      head: 'feat',
      base: 'main',
      body: 'B',
    });
  });

  it('maps merged / open / closed states', async () => {
    const p = new GithubForgeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        number: 1,
        html_url: '',
        state: 'closed',
        merged: true,
        merged_at: '2026-01-02T03:04:05Z',
      }),
    );
    expect(await p.getPullRequestState(ctx(), '1')).toEqual({
      state: 'merged',
      mergedAt: new Date('2026-01-02T03:04:05Z'),
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ number: 1, html_url: '', state: 'open' }));
    expect(await p.getPullRequestState(ctx(), '1')).toEqual({ state: 'open', mergedAt: null });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ number: 1, html_url: '', state: 'closed', merged: false }),
    );
    expect(await p.getPullRequestState(ctx(), '1')).toEqual({ state: 'closed', mergedAt: null });
  });

  it('maps 403 to ForgeAuthError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Resource not accessible by token' }, 403));
    await expect(new GithubForgeProvider().getPullRequestState(ctx(), '1')).rejects.toBeInstanceOf(
      ForgeAuthError,
    );
  });

  it('returns the existing PR on a create conflict', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'A pull request already exists' }, 422))
      .mockResolvedValueOnce(
        jsonResponse([{ number: 42, html_url: 'https://github.com/acme/app/pull/42' }]),
      );
    const res = await new GithubForgeProvider().openPullRequest(ctx(), OPEN_INPUT);
    expect(res).toEqual({ url: 'https://github.com/acme/app/pull/42', number: '42' });
  });
});

describe('gitea adapter', () => {
  it('uses token auth and the /api/v1 base', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ number: 3, html_url: 'https://gitea.acme.io/acme/app/pulls/3' }, 201),
    );
    const res = await new GiteaForgeProvider().openPullRequest(
      ctx({ provider: 'gitea', apiBase: 'https://gitea.acme.io/api/v1', host: 'gitea.acme.io' }),
      OPEN_INPUT,
    );
    expect(res.number).toBe('3');
    const { url, init } = lastCall();
    expect(url).toBe('https://gitea.acme.io/api/v1/repos/acme/app/pulls');
    expect(init.headers.Authorization).toBe('token tok');
  });
});

describe('gitlab adapter', () => {
  it('uses PRIVATE-TOKEN, an encoded project id, and source/target branch', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ iid: 9, web_url: 'https://gitlab.com/g/s/app/-/merge_requests/9' }, 201),
    );
    const res = await new GitlabForgeProvider().openPullRequest(
      ctx({
        provider: 'gitlab',
        apiBase: 'https://gitlab.com/api/v4',
        host: 'gitlab.com',
        owner: 'g/s',
        repo: 'app',
      }),
      OPEN_INPUT,
    );
    expect(res).toEqual({ url: 'https://gitlab.com/g/s/app/-/merge_requests/9', number: '9' });
    const { url, init } = lastCall();
    expect(url).toBe('https://gitlab.com/api/v4/projects/g%2Fs%2Fapp/merge_requests');
    expect(init.headers['PRIVATE-TOKEN']).toBe('tok');
    expect(JSON.parse(init.body ?? '')).toEqual({
      source_branch: 'feat',
      target_branch: 'main',
      title: 'T',
      description: 'B',
    });
  });

  it('maps opened -> open and merged', async () => {
    const p = new GitlabForgeProvider();
    fetchMock.mockResolvedValueOnce(jsonResponse({ iid: 1, web_url: '', state: 'opened' }));
    expect((await p.getPullRequestState(ctx({ provider: 'gitlab' }), '1')).state).toBe('open');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ iid: 1, web_url: '', state: 'merged', merged_at: '2026-01-02T00:00:00Z' }),
    );
    expect((await p.getPullRequestState(ctx({ provider: 'gitlab' }), '1')).state).toBe('merged');
  });
});

describe('bitbucket cloud adapter', () => {
  it('uses Basic auth and source/destination branches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { id: 5, links: { html: { href: 'https://bitbucket.org/acme/app/pull-requests/5' } } },
        201,
      ),
    );
    const res = await new BitbucketCloudForgeProvider().openPullRequest(
      ctx({
        provider: 'bitbucket_cloud',
        apiBase: 'https://api.bitbucket.org/2.0',
        host: 'bitbucket.org',
      }),
      OPEN_INPUT,
    );
    expect(res).toEqual({ url: 'https://bitbucket.org/acme/app/pull-requests/5', number: '5' });
    const { url, init } = lastCall();
    expect(url).toBe('https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('user:tok').toString('base64')}`);
    expect(JSON.parse(init.body ?? '')).toEqual({
      title: 'T',
      description: 'B',
      source: { branch: { name: 'feat' } },
      destination: { branch: { name: 'main' } },
    });
  });

  it('maps MERGED/DECLINED/OPEN', async () => {
    const p = new BitbucketCloudForgeProvider();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 5, state: 'MERGED', updated_on: '2026-01-02T00:00:00Z' }),
    );
    expect((await p.getPullRequestState(ctx({ provider: 'bitbucket_cloud' }), '5')).state).toBe(
      'merged',
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 5, state: 'DECLINED' }));
    expect((await p.getPullRequestState(ctx({ provider: 'bitbucket_cloud' }), '5')).state).toBe(
      'closed',
    );
  });
});

describe('bitbucket server adapter', () => {
  it('uses Bearer auth and fromRef/toRef', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          id: 11,
          links: {
            self: [{ href: 'https://bb.acme.io/projects/PROJ/repos/app/pull-requests/11' }],
          },
        },
        201,
      ),
    );
    const res = await new BitbucketServerForgeProvider().openPullRequest(
      ctx({
        provider: 'bitbucket_server',
        apiBase: 'https://bb.acme.io/rest/api/1.0',
        host: 'bb.acme.io',
        owner: 'PROJ',
      }),
      OPEN_INPUT,
    );
    expect(res).toEqual({
      url: 'https://bb.acme.io/projects/PROJ/repos/app/pull-requests/11',
      number: '11',
    });
    const { url, init } = lastCall();
    expect(url).toBe('https://bb.acme.io/rest/api/1.0/projects/PROJ/repos/app/pull-requests');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body ?? '')).toEqual({
      title: 'T',
      description: 'B',
      fromRef: { id: 'refs/heads/feat' },
      toRef: { id: 'refs/heads/main' },
    });
  });
});

describe('parseRemote', () => {
  it('parses an https URL', () => {
    expect(parseRemote('https://github.com/acme/app.git', 'github')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
    });
  });
  it('parses an scp-style ssh URL', () => {
    expect(parseRemote('git@github.com:acme/app.git', 'github')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
    });
  });
  it('keeps a GitLab subgroup path in the owner', () => {
    expect(parseRemote('https://gitlab.com/group/sub/app.git', 'gitlab')).toEqual({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'app',
    });
  });
  it('strips the /scm prefix for Bitbucket Server', () => {
    expect(parseRemote('https://bb.acme.io/scm/PROJ/app.git', 'bitbucket_server')).toEqual({
      host: 'bb.acme.io',
      owner: 'PROJ',
      repo: 'app',
    });
  });
});

describe('credential forge inference', () => {
  it('extracts the host from https and scp remotes', () => {
    expect(hostFromRemote('https://gitlab.com/martin/rs_test.git')).toBe('gitlab.com');
    expect(hostFromRemote('git@github.com:acme/app.git')).toBe('github.com');
  });
  it('infers the forge for well-known public hosts only', () => {
    expect(inferForgeProviderFromHost('gitlab.com')).toBe('gitlab');
    expect(inferForgeProviderFromHost('github.com')).toBe('github');
    expect(inferForgeProviderFromHost('codeberg.org')).toBe('gitea');
    expect(inferForgeProviderFromHost('bitbucket.org')).toBe('bitbucket_cloud');
    expect(inferForgeProviderFromHost('git.self-hosted.example')).toBeNull();
  });
  it('resolves a blank-provider credential from its host (the picker bug)', () => {
    // An "auto-detect" GitLab credential (blank provider) must still resolve to gitlab so
    // it is offered for a gitlab.com repo instead of being dropped from the picker.
    expect(credentialForgeProvider('', 'gitlab.com')).toBe('gitlab');
    expect(credentialForgeProvider(null, 'gitlab.com')).toBe('gitlab');
    // An explicit provider wins over the host (self-hosted Gitea on any host).
    expect(credentialForgeProvider('gitea', 'git.self-hosted.example')).toBe('gitea');
    // Blank provider on a self-hosted host stays unresolved (needs an explicit pick).
    expect(credentialForgeProvider('', 'git.self-hosted.example')).toBeNull();
  });
});
