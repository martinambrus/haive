import { describe, expect, it } from 'vitest';
import {
  fetchGithubUser,
  isPendingError,
  pollAccessToken,
  startDeviceCode,
} from '../src/routes/github-oauth.js';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    const entry = responses[idx] ?? responses[responses.length - 1]!;
    idx += 1;
    const res = new Response(JSON.stringify(entry.body), {
      status: entry.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
    return res;
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

describe('startDeviceCode', () => {
  it('posts form-encoded client_id + scope and returns parsed body', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: {
          device_code: 'dc-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        },
      },
    ]);
    const result = await startDeviceCode(fetch, 'cid-xyz');
    expect(result.device_code).toBe('dc-123');
    expect(result.user_code).toBe('ABCD-1234');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://github.com/login/device/code');
    const body = calls[0]!.init!.body as URLSearchParams;
    expect(body.get('client_id')).toBe('cid-xyz');
    expect(body.get('scope')).toBe('repo');
  });

  it('throws 502 when GitHub returns non-ok', async () => {
    const { fetch } = mockFetch([{ status: 500, body: { error: 'boom' } }]);
    await expect(startDeviceCode(fetch, 'cid')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('throws 502 when response is missing fields', async () => {
    const { fetch } = mockFetch([{ body: { device_code: 'dc', user_code: 'UC' } }]);
    await expect(startDeviceCode(fetch, 'cid')).rejects.toMatchObject({ status: 502 });
  });
});

describe('pollAccessToken', () => {
  it('returns authorization_pending unchanged for polling callers', async () => {
    const { fetch } = mockFetch([{ body: { error: 'authorization_pending' } }]);
    const result = await pollAccessToken(fetch, 'cid', 'dc-123');
    expect(result).toEqual({ error: 'authorization_pending' });
    expect(isPendingError(result)).toBe(true);
  });

  it('returns access_token on success', async () => {
    const { fetch, calls } = mockFetch([
      {
        body: { access_token: 'ghp_abc', token_type: 'bearer', scope: 'repo' },
      },
    ]);
    const result = await pollAccessToken(fetch, 'cid', 'dc-123');
    expect(result).toEqual({ access_token: 'ghp_abc', token_type: 'bearer', scope: 'repo' });
    expect(isPendingError(result)).toBe(false);
    expect(calls[0]!.url).toBe('https://github.com/login/oauth/access_token');
    const body = calls[0]!.init!.body as URLSearchParams;
    expect(body.get('device_code')).toBe('dc-123');
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('treats slow_down as pending', async () => {
    const { fetch } = mockFetch([{ body: { error: 'slow_down' } }]);
    const result = await pollAccessToken(fetch, 'cid', 'dc-123');
    expect(isPendingError(result)).toBe(true);
  });

  it('does not treat expired_token as pending', async () => {
    const { fetch } = mockFetch([{ body: { error: 'expired_token' } }]);
    const result = await pollAccessToken(fetch, 'cid', 'dc-123');
    expect(isPendingError(result)).toBe(false);
  });
});

describe('fetchGithubUser', () => {
  it('sends bearer token and returns login', async () => {
    const { fetch, calls } = mockFetch([{ body: { login: 'octocat', id: 42 } }]);
    const user = await fetchGithubUser(fetch, 'ghp_token');
    expect(user.login).toBe('octocat');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_token');
  });

  it('throws 502 when login field is missing', async () => {
    const { fetch } = mockFetch([{ body: { id: 42 } }]);
    await expect(fetchGithubUser(fetch, 'ghp_token')).rejects.toMatchObject({ status: 502 });
  });

  it('throws 502 on non-ok response', async () => {
    const { fetch } = mockFetch([{ status: 401, body: { message: 'Bad credentials' } }]);
    await expect(fetchGithubUser(fetch, 'bad')).rejects.toMatchObject({ status: 502 });
  });
});
