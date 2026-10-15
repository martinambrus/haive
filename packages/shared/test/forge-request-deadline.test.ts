import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BitbucketCloudForgeProvider,
  BitbucketServerForgeProvider,
  FORGE_REQUEST_TIMEOUT_MS,
  ForgeAuthError,
  ForgeError,
  GiteaForgeProvider,
  GithubForgeProvider,
  GitlabForgeProvider,
  type ForgeContext,
  type ForgeProvider,
} from '../src/forge/index.js';

const DEADLINE_MS = 25;
const TEST_TIMEOUT_MS = 2_000;

const ctx: ForgeContext = {
  provider: 'github',
  apiBase: 'https://api.github.com',
  host: 'github.com',
  owner: 'acme',
  repo: 'app',
  token: 'tok',
  username: 'user',
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fetch that never answers, and rejects with the signal's reason once it is aborted, as the real one does. */
const neverAnswers = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as typeof fetch;

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (err: unknown) => err,
  );

const signalOfCall = (index = 0): AbortSignal => {
  const signal = fetchMock.mock.calls[index]?.[1]?.signal;
  if (!signal) throw new Error('fetch was called without a signal');
  return signal;
};

describe('the forge request deadline', () => {
  it.each([
    ['github', () => new GithubForgeProvider(DEADLINE_MS)],
    ['gitea', () => new GiteaForgeProvider(DEADLINE_MS)],
    ['gitlab', () => new GitlabForgeProvider(DEADLINE_MS)],
    ['bitbucket_cloud', () => new BitbucketCloudForgeProvider(DEADLINE_MS)],
    ['bitbucket_server', () => new BitbucketServerForgeProvider(DEADLINE_MS)],
  ] as [string, () => ForgeProvider][])(
    'aborts a %s request that never answers at the injected deadline',
    async (_name, make) => {
      fetchMock.mockImplementation(neverAnswers);

      const err = await rejection(make().getPullRequestState(ctx, '1'));

      expect(err).toBeInstanceOf(ForgeError);
      expect(err).not.toBeInstanceOf(ForgeAuthError);
      expect((err as ForgeError).message).toContain(`timed out after ${DEADLINE_MS} ms`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(signalOfCall().aborted).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'aborts a pull request that is being opened too',
    async () => {
      fetchMock.mockImplementation(neverAnswers);

      const err = await rejection(
        new GithubForgeProvider(DEADLINE_MS).openPullRequest(ctx, {
          head: 'feat',
          base: 'main',
          title: 'T',
          body: 'B',
        }),
      );

      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).message).toContain('timed out');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'aborts an answer whose body never finishes',
    async () => {
      fetchMock.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch);

      const err = await rejection(
        new GithubForgeProvider(DEADLINE_MS).getPullRequestState(ctx, '1'),
      );

      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).message).toContain(`timed out after ${DEADLINE_MS} ms`);
    },
    TEST_TIMEOUT_MS,
  );

  it('lets an answer that arrives inside the deadline through', async () => {
    fetchMock.mockImplementation((async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ number: 1, html_url: '', state: 'open' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);

    const state = await new GithubForgeProvider(5_000).getPullRequestState(ctx, '1');

    expect(state).toEqual({ state: 'open', mergedAt: null });
    expect(signalOfCall().aborted).toBe(false);
  });

  it('keeps reporting a failed connection as a failed request, not a timeout', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const err = await rejection(new GithubForgeProvider(5_000).getPullRequestState(ctx, '1'));

    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).message).toContain('request failed');
    expect((err as ForgeError).message).not.toContain('timed out');
  });

  it('asks for 30 seconds when no deadline is injected', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ number: 1, html_url: '', state: 'open' }), { status: 200 }),
    );

    await new GithubForgeProvider().getPullRequestState(ctx, '1');

    expect(FORGE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
});

describe('a signal the caller puts on the context', () => {
  const PROVIDERS: [string, () => ForgeProvider][] = [
    ['github', () => new GithubForgeProvider()],
    ['gitea', () => new GiteaForgeProvider()],
    ['gitlab', () => new GitlabForgeProvider()],
    ['bitbucket_cloud', () => new BitbucketCloudForgeProvider()],
    ['bitbucket_server', () => new BitbucketServerForgeProvider()],
  ];
  const OPEN_INPUT = { head: 'feat', base: 'main', title: 'T', body: 'B' };

  it.each(PROVIDERS)(
    'aborts a %s request that never answers as soon as the caller aborts, long before its own deadline',
    async (_name, make) => {
      fetchMock.mockImplementation(neverAnswers);
      const caller = new AbortController();

      const pending = rejection(make().getPullRequestState({ ...ctx, signal: caller.signal }, '1'));
      caller.abort();
      const err = await pending;

      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).message).toContain('was cancelled');
      expect((err as ForgeError).message).not.toContain('timed out');
      expect(signalOfCall().aborted).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'shares the signal with the lookup that follows a refused create',
    async () => {
      const caller = new AbortController();
      fetchMock
        .mockResolvedValueOnce(new Response('{"message":"exists"}', { status: 422 }))
        .mockImplementationOnce(neverAnswers);

      const pending = rejection(
        new GithubForgeProvider().openPullRequest({ ...ctx, signal: caller.signal }, OPEN_INPUT),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(signalOfCall(1).aborted).toBe(false);
      caller.abort();
      const err = await pending;

      expect(err).toBeInstanceOf(ForgeError);
      expect((err as ForgeError).message).toContain('was cancelled');
      expect(signalOfCall(1).aborted).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it('stops a request at once when the signal is already aborted', async () => {
    fetchMock.mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    const caller = new AbortController();
    caller.abort();

    const err = await rejection(
      new GithubForgeProvider().getPullRequestState({ ...ctx, signal: caller.signal }, '1'),
    );

    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).message).toContain('was cancelled');
  });

  it('still lets its own deadline end a request when the caller signal stays quiet', async () => {
    fetchMock.mockImplementation(neverAnswers);
    const caller = new AbortController();

    const err = await rejection(
      new GithubForgeProvider(DEADLINE_MS).getPullRequestState(
        { ...ctx, signal: caller.signal },
        '1',
      ),
    );

    expect((err as ForgeError).message).toContain(`timed out after ${DEADLINE_MS} ms`);
    expect(caller.signal.aborted).toBe(false);
  });

  it('serves an answer that arrives while the caller signal stays quiet', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ number: 1, html_url: '', state: 'open' }), { status: 200 }),
    );
    const caller = new AbortController();

    const state = await new GithubForgeProvider().getPullRequestState(
      { ...ctx, signal: caller.signal },
      '1',
    );

    expect(state).toEqual({ state: 'open', mergedAt: null });
    expect(signalOfCall().aborted).toBe(false);
  });
});
