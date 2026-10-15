import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BitbucketCloudForgeProvider,
  ForgeError,
  GithubForgeProvider,
  type ForgeContext,
} from '../src/forge/index.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ctxWith = (token: string, over: Partial<ForgeContext> = {}): ForgeContext => ({
  provider: 'github',
  apiBase: 'https://api.github.com',
  host: 'github.com',
  owner: 'acme',
  repo: 'app',
  token,
  username: 'octocat',
  ...over,
});

const secretOf = (length: number): string => {
  let out = `tok${randomUUID().replace(/-/g, '')}`;
  while (out.length < length) out += randomUUID().replace(/-/g, '');
  return out.slice(0, length);
};

/** Every 12-character window of the secret that the text still holds. */
const leaked = (text: string, secret: string): string[] => {
  const found: string[] = [];
  for (let i = 0; i + 12 <= secret.length; i += 1) {
    const window = secret.slice(i, i + 12);
    if (text.includes(window)) found.push(window);
  }
  return found;
};

const failure = async (promise: Promise<unknown>): Promise<ForgeError> => {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ForgeError);
  return err as ForgeError;
};

const echo = (status: number, before: string) => () =>
  Promise.resolve(new Response(`${before}`, { status, headers: { 'content-type': 'text/plain' } }));

describe('a vendor error that echoes the credential', () => {
  it('keeps no part of a token that the 500-character cut would split', async () => {
    const token = secretOf(60);
    const padding = 'x'.repeat(470);
    fetchMock.mockImplementation((_url, init) =>
      echo(401, `${padding} received ${new Headers(init?.headers).get('authorization')} end`)(),
    );

    const err = await failure(new GithubForgeProvider().getPullRequestState(ctxWith(token), '1'));

    expect(leaked(err.message, token)).toEqual([]);
    expect(err.message).toContain('[redacted]');
  });

  it('keeps no part of a token longer than the cut itself', async () => {
    const token = secretOf(700);
    fetchMock.mockImplementation((_url, init) =>
      echo(403, `received ${new Headers(init?.headers).get('authorization')}`)(),
    );

    const err = await failure(new GithubForgeProvider().getPullRequestState(ctxWith(token), '1'));

    expect(leaked(err.message, token)).toEqual([]);
  });

  it('keeps no part of the Basic form Bitbucket Cloud sends', async () => {
    const token = secretOf(48);
    const basic = Buffer.from(`octocat:${token}`).toString('base64');
    fetchMock.mockImplementation((_url, init) =>
      echo(401, `${'y'.repeat(480)} ${new Headers(init?.headers).get('authorization')}`)(),
    );

    const err = await failure(
      new BitbucketCloudForgeProvider().getPullRequestState(
        ctxWith(token, {
          provider: 'bitbucket_cloud',
          apiBase: 'https://api.bitbucket.org/2.0',
          host: 'bitbucket.org',
        }),
        '1',
      ),
    );

    expect(leaked(err.message, basic)).toEqual([]);
    expect(leaked(err.message, token)).toEqual([]);
  });

  it('keeps no start of a token that the 4 KiB read cut off, even when redaction shortens the text', async () => {
    const token = secretOf(90);
    const unit = `${token} `;
    const repeats = Math.floor(4096 / unit.length) + 1;
    fetchMock.mockImplementation(() => echo(500, unit.repeat(repeats))());

    const err = await failure(new GithubForgeProvider().getPullRequestState(ctxWith(token), '1'));

    expect(leaked(err.message, token)).toEqual([]);
  });

  it('leaves the rest of the vendor text alone', async () => {
    const token = secretOf(40);
    fetchMock.mockImplementation(() =>
      echo(422, 'Validation Failed: a pull request already exists (application/json)')(),
    );

    const err = await failure(new GithubForgeProvider().getPullRequestState(ctxWith(token), '1'));

    expect(err.message).toContain(
      'Validation Failed: a pull request already exists (application/json)',
    );
    expect(err.message).not.toContain('[redacted]');
  });
});
