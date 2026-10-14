import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decrypt, decryptDek } from '../src/crypto/index.js';
import {
  OauthUnavailableError,
  OauthVendorError,
  VENDOR_CALL_TIMEOUT_MS,
  type OauthClientCredentials,
  buildAuthorizeUrl,
  createPkcePair,
  decryptConnectionTokens,
  encryptConnectionTokens,
  exchangeAuthorizationCode,
  fetchUserInfo,
  getIntegrationProvider,
  listIntegrationProviders,
  pollDeviceToken,
  refreshAccessToken,
  revokeToken,
  startDeviceAuthorization,
} from '../src/integrations/index.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const TOKEN_URL = 'https://auth.example.com/token';
const REVOKE_URL = 'https://auth.example.com/revoke';
const DEVICE_URL = 'https://auth.example.com/device/code';
const REDIRECT = 'https://haive.example/settings/integrations/callback/acme';
const CLIENT: OauthClientCredentials = {
  clientId: 'stub-client-id',
  clientSecret: 'stub-client-secret',
};
const PUBLIC_CLIENT: OauthClientCredentials = { clientId: 'stub-client-id', clientSecret: null };
const KEK = 'ab'.repeat(32);

interface Call {
  url: string;
  method: string;
  headers: Headers;
  form: Record<string, string>;
  signal: AbortSignal | null | undefined;
  redirect: RequestInit['redirect'];
}

function stub(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
      signal: init?.signal,
      redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

const TOKENS = {
  access_token: 'stub-access-1',
  refresh_token: 'stub-refresh-1',
  expires_in: 3600,
  token_type: 'bearer',
  scope: 'repo gist',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createPkcePair', () => {
  it('makes an S256 challenge of a 43 character URL-safe verifier, fresh each time', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});

describe('buildAuthorizeUrl', () => {
  const input = {
    authorizeUrl: 'https://auth.example.com/authorize?prompt=consent',
    clientId: 'stub-client-id',
    redirectUri: REDIRECT,
    scopes: ['repo', 'read:user'],
    state: 'state-1',
    challenge: 'challenge-1',
  };

  it('asks for a code with the S256 challenge and keeps the query it was given', () => {
    const url = new URL(buildAuthorizeUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.example.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      prompt: 'consent',
      response_type: 'code',
      client_id: 'stub-client-id',
      redirect_uri: REDIRECT,
      scope: 'repo read:user',
      state: 'state-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
    });
  });

  it('leaves scope out when none is asked for', () => {
    const url = new URL(buildAuthorizeUrl({ ...input, scopes: [] }));
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('exchangeAuthorizationCode', () => {
  const exchange = (fetchFn: typeof fetch, client = CLIENT) =>
    exchangeAuthorizationCode(fetchFn, {
      tokenUrl: TOKEN_URL,
      client,
      code: 'stub-code',
      redirectUri: REDIRECT,
      verifier: 'stub-verifier',
      now: () => NOW,
    });

  it('posts the code as client_secret_post, asks for JSON and parses the tokens', async () => {
    const { fetchFn, calls } = stub(() => json(200, TOKENS));
    const tokens = await exchange(fetchFn);
    expect(tokens).toEqual({
      accessToken: 'stub-access-1',
      refreshToken: 'stub-refresh-1',
      expiresAt: new Date(NOW + 3_600_000),
      scopes: ['repo', 'gist'],
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(TOKEN_URL);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    expect(call?.form).toEqual({
      grant_type: 'authorization_code',
      code: 'stub-code',
      redirect_uri: REDIRECT,
      client_id: 'stub-client-id',
      client_secret: 'stub-client-secret',
      code_verifier: 'stub-verifier',
    });
  });

  it('sends no client_secret for a client that has none', async () => {
    const { fetchFn, calls } = stub(() => json(200, TOKENS));
    await exchange(fetchFn, PUBLIC_CLIENT);
    expect(calls[0]?.form).not.toHaveProperty('client_secret');
  });

  it.each([
    ['comma separated, as GitHub sends them', 'repo,gist', ['repo', 'gist']],
    ['space separated, as RFC 6749 sends them', 'repo  gist', ['repo', 'gist']],
    ['one scope', 'repo', ['repo']],
    ['empty', '', []],
  ])('reads scope that is %s', async (_name, scope, expected) => {
    const { fetchFn } = stub(() => json(200, { ...TOKENS, scope }));
    expect((await exchange(fetchFn)).scopes).toEqual(expected);
  });

  it('reports what the vendor left out as null', async () => {
    const { fetchFn } = stub(() => json(200, { access_token: 'stub-access-1' }));
    expect(await exchange(fetchFn)).toEqual({
      accessToken: 'stub-access-1',
      refreshToken: null,
      expiresAt: null,
      scopes: null,
    });
  });

  it('reads a lifetime sent as a string', async () => {
    const { fetchFn } = stub(() => json(200, { ...TOKENS, expires_in: '60' }));
    expect((await exchange(fetchFn)).expiresAt).toEqual(new Date(NOW + 60_000));
  });

  it('refuses a response without an access token', async () => {
    const { fetchFn } = stub(() => json(200, { token_type: 'bearer' }));
    expect(await rejection(exchange(fetchFn))).toBeInstanceOf(OauthUnavailableError);
  });
});

describe('refreshAccessToken', () => {
  const refresh = (fetchFn: typeof fetch, client = CLIENT) =>
    refreshAccessToken(fetchFn, {
      tokenUrl: TOKEN_URL,
      client,
      refreshToken: 'stub-refresh-0',
      now: () => NOW,
    });

  it('posts the refresh token with the client and no scope, so it can never narrow', async () => {
    const { fetchFn, calls } = stub(() => json(200, TOKENS));
    const tokens = await refresh(fetchFn);
    expect(tokens.accessToken).toBe('stub-access-1');
    expect(tokens.expiresAt).toEqual(new Date(NOW + 3_600_000));
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'stub-refresh-0',
      client_id: 'stub-client-id',
      client_secret: 'stub-client-secret',
    });
  });

  it('reports no refresh token when the vendor did not rotate it', async () => {
    const { fetchFn } = stub(() => json(200, { access_token: 'stub-access-2', expires_in: 60 }));
    expect((await refresh(fetchFn, PUBLIC_CLIENT)).refreshToken).toBeNull();
  });
});

describe('vendor answers', () => {
  const refresh = (fetchFn: typeof fetch) =>
    refreshAccessToken(fetchFn, {
      tokenUrl: TOKEN_URL,
      client: CLIENT,
      refreshToken: 'stub-refresh-0',
    });

  it('classifies a vendor error by its JSON code and keeps the description', async () => {
    const { fetchFn } = stub(() =>
      json(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid.' }),
    );
    const err = await rejection(refresh(fetchFn));
    expect(err).toBeInstanceOf(OauthVendorError);
    expect(err).toMatchObject({
      code: 'invalid_grant',
      description: 'The refresh token is invalid.',
      httpStatus: 400,
    });
  });

  it('reads an error code out of a 200, which is how GitHub answers', async () => {
    const { fetchFn } = stub(() => json(200, { error: 'bad_verification_code' }));
    expect(await rejection(refresh(fetchFn))).toMatchObject({
      code: 'bad_verification_code',
      description: null,
      httpStatus: 200,
    });
  });

  it('never classifies by message text', async () => {
    const { fetchFn } = stub(() =>
      json(400, { error: 'server_busy', error_description: 'invalid_grant' }),
    );
    expect(await rejection(refresh(fetchFn))).toMatchObject({ code: 'server_busy' });
    const other = stub(() =>
      json(400, { error: 'invalid_grant', error_description: 'try again later, server busy' }),
    );
    expect(await rejection(refresh(other.fetchFn))).toMatchObject({ code: 'invalid_grant' });
  });

  it('takes a 5xx for an unavailable provider even when its body names a code', async () => {
    const { fetchFn } = stub(() => json(503, { error: 'invalid_grant' }));
    const err = await rejection(refresh(fetchFn));
    expect(err).toBeInstanceOf(OauthUnavailableError);
    expect(err).not.toBeInstanceOf(OauthVendorError);
  });

  it.each([
    ['an HTML gateway page', () => new Response('<html>Bad gateway</html>', { status: 502 })],
    ['a 200 that is not JSON', () => new Response('ok', { status: 200 })],
    ['a 4xx JSON without an error code', () => json(401, { message: 'Bad credentials' })],
    ['a JSON array', () => json(200, ['stub-access-1'])],
  ])('treats %s as an unavailable provider', async (_name, response) => {
    const { fetchFn } = stub(response);
    expect(await rejection(refresh(fetchFn))).toBeInstanceOf(OauthUnavailableError);
  });

  it('treats a network failure as an unavailable provider and keeps the cause', async () => {
    const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const fetchFn = (async () => {
      throw new TypeError('fetch failed', { cause });
    }) as typeof fetch;
    const err = await rejection(refresh(fetchFn));
    expect(err).toBeInstanceOf(OauthUnavailableError);
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it('treats a timeout as an unavailable provider', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(30));
    const fetchFn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await rejection(refresh(fetchFn));
    expect(err).toBeInstanceOf(OauthUnavailableError);
    expect(((err as Error).cause as Error).name).toBe('TimeoutError');
  });

  it('blanks the secrets it sent out of whatever the vendor echoes back', async () => {
    const { fetchFn } = stub(() =>
      json(400, {
        error: 'invalid_grant',
        error_description: 'Token stub-refresh-0 was revoked for stub-client-secret',
      }),
    );
    const err = (await rejection(refresh(fetchFn))) as OauthVendorError;
    expect(err.description).toBe('Token [redacted] was revoked for [redacted]');
    expect(err.message).not.toContain('stub-refresh-0');
    expect(err.message).not.toContain('stub-client-secret');
  });

  it('blanks the secrets it sent out of the error code too, and keeps it to 100 characters', async () => {
    const echoed = stub(() => json(400, { error: 'bad stub-refresh-0 for stub-client-secret' }));
    const err = (await rejection(refresh(echoed.fetchFn))) as OauthVendorError;
    expect(err.code).toBe('bad [redacted] for [redacted]');
    expect(err.message).not.toContain('stub-refresh-0');
    expect(err.message).not.toContain('stub-client-secret');
    const long = stub(() => json(400, { error: 'x'.repeat(2000) }));
    expect(((await rejection(refresh(long.fetchFn))) as OauthVendorError).code).toHaveLength(100);
  });

  it('keeps a description to 500 characters', async () => {
    const { fetchFn } = stub(() =>
      json(400, { error: 'invalid_grant', error_description: 'x'.repeat(2000) }),
    );
    expect(((await rejection(refresh(fetchFn))) as OauthVendorError).description).toHaveLength(500);
  });
});

describe('revokeToken', () => {
  const revoke = (fetchFn: typeof fetch, revokeUrl: string | undefined) =>
    revokeToken(fetchFn, {
      revokeUrl,
      client: CLIENT,
      token: 'stub-refresh-1',
      tokenTypeHint: 'refresh_token',
    });

  it('asks nothing of a provider without a revoke url', async () => {
    const { fetchFn, calls } = stub(() => json(200, {}));
    expect(await revoke(fetchFn, undefined)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('posts the token with its hint and the client, and accepts an empty 200', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 200 }));
    expect(await revoke(fetchFn, REVOKE_URL)).toBe(true);
    expect(calls[0]?.url).toBe(REVOKE_URL);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.form).toEqual({
      token: 'stub-refresh-1',
      token_type_hint: 'refresh_token',
      client_id: 'stub-client-id',
      client_secret: 'stub-client-secret',
    });
  });

  it('raises a vendor error by its code and an outage as unavailable', async () => {
    const refused = stub(() => json(400, { error: 'unsupported_token_type' }));
    expect(await rejection(revoke(refused.fetchFn, REVOKE_URL))).toMatchObject({
      code: 'unsupported_token_type',
    });
    const down = stub(() => new Response('', { status: 503 }));
    expect(await rejection(revoke(down.fetchFn, REVOKE_URL))).toBeInstanceOf(OauthUnavailableError);
  });
});

describe('device flow', () => {
  const start = (fetchFn: typeof fetch) =>
    startDeviceAuthorization(fetchFn, {
      deviceCodeUrl: DEVICE_URL,
      clientId: 'stub-client-id',
      scopes: ['repo'],
    });
  const poll = (fetchFn: typeof fetch, interval = 5, client = CLIENT) =>
    pollDeviceToken(fetchFn, {
      tokenUrl: TOKEN_URL,
      client,
      deviceCode: 'stub-device-code',
      interval,
      now: () => NOW,
    });
  const DEVICE = {
    device_code: 'stub-device-code',
    user_code: 'WDJB-MJHT',
    verification_uri: 'https://auth.example.com/device',
    expires_in: 900,
    interval: 7,
  };

  it('starts with the client id and scope only, and reads the codes', async () => {
    const { fetchFn, calls } = stub(() => json(200, DEVICE));
    expect(await start(fetchFn)).toEqual({
      deviceCode: 'stub-device-code',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://auth.example.com/device',
      expiresIn: 900,
      interval: 7,
    });
    expect(calls[0]?.url).toBe(DEVICE_URL);
    expect(calls[0]?.form).toEqual({ client_id: 'stub-client-id', scope: 'repo' });
  });

  it('polls every 5 seconds when the vendor names no interval', async () => {
    const { interval: _omitted, ...withoutInterval } = DEVICE;
    const { fetchFn } = stub(() => json(200, withoutInterval));
    expect((await start(fetchFn)).interval).toBe(5);
  });

  it.each(['device_code', 'user_code', 'verification_uri', 'expires_in'])(
    'refuses a start response without %s',
    async (field) => {
      const { fetchFn } = stub(() => json(200, { ...DEVICE, [field]: undefined }));
      expect(await rejection(start(fetchFn))).toBeInstanceOf(OauthUnavailableError);
    },
  );

  it('polls with the device grant and the client', async () => {
    const { fetchFn, calls } = stub(() => json(200, TOKENS));
    const result = await poll(fetchFn);
    expect(result).toEqual({
      status: 'complete',
      tokens: {
        accessToken: 'stub-access-1',
        refreshToken: 'stub-refresh-1',
        expiresAt: new Date(NOW + 3_600_000),
        scopes: ['repo', 'gist'],
      },
    });
    expect(calls[0]?.url).toBe(TOKEN_URL);
    expect(calls[0]?.form).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'stub-device-code',
      client_id: 'stub-client-id',
      client_secret: 'stub-client-secret',
    });
  });

  it('keeps waiting on authorization_pending at the same interval, 200 or 400', async () => {
    for (const status of [200, 400]) {
      const { fetchFn } = stub(() => json(status, { error: 'authorization_pending' }));
      expect(await poll(fetchFn, 5, PUBLIC_CLIENT)).toEqual({ status: 'pending', interval: 5 });
    }
  });

  it('adds 5 seconds to the interval on slow_down, every time it is told', async () => {
    const { fetchFn } = stub(() => json(400, { error: 'slow_down' }));
    expect(await poll(fetchFn, 5)).toEqual({ status: 'pending', interval: 10 });
    expect(await poll(fetchFn, 10)).toEqual({ status: 'pending', interval: 15 });
  });

  it.each(['access_denied', 'expired_token'])('raises %s as a vendor error', async (code) => {
    const { fetchFn } = stub(() => json(200, { error: code }));
    const err = await rejection(poll(fetchFn));
    expect(err).toBeInstanceOf(OauthVendorError);
    expect(err).toMatchObject({ code });
  });

  it('raises an outage as unavailable, not as pending', async () => {
    const { fetchFn } = stub(() => new Response('', { status: 502 }));
    expect(await rejection(poll(fetchFn))).toBeInstanceOf(OauthUnavailableError);
  });
});

describe('fetchUserInfo', () => {
  const github = {
    url: 'https://api.github.com/user',
    idPointer: '/id',
    labelPointer: '/login',
  };

  it('sends the access token as a bearer and reads the account out of the JSON', async () => {
    const { fetchFn, calls } = stub(() =>
      json(200, { id: 583231, login: 'octocat', name: 'The Octocat' }),
    );
    expect(await fetchUserInfo(fetchFn, github, 'stub-access-1')).toEqual({
      externalAccountId: '583231',
      accountLabel: 'octocat',
    });
    expect(calls[0]?.url).toBe('https://api.github.com/user');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer stub-access-1');
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
  });

  it('follows nested pointers and their ~0 and ~1 escapes', async () => {
    const { fetchFn } = stub(() =>
      json(200, { 'a/b': { 'c~d': 'ident-1' }, people: [{ name: 'Ada' }] }),
    );
    const info = await fetchUserInfo(
      fetchFn,
      { url: github.url, idPointer: '/a~1b/c~0d', labelPointer: '/people/0/name' },
      'stub-access-1',
    );
    expect(info).toEqual({ externalAccountId: 'ident-1', accountLabel: 'Ada' });
  });

  it.each([
    ['no id', { login: 'octocat' }],
    ['an id that is an object', { id: {}, login: 'octocat' }],
    ['no label', { id: 1 }],
    ['an empty label', { id: 1, login: '' }],
  ])('refuses a response with %s', async (_name, body) => {
    const { fetchFn } = stub(() => json(200, body));
    expect(await rejection(fetchUserInfo(fetchFn, github, 'stub-access-1'))).toBeInstanceOf(
      OauthUnavailableError,
    );
  });

  it('raises a refusal as unavailable without the token in the message', async () => {
    const { fetchFn } = stub(() => new Response('denied for stub-access-1', { status: 401 }));
    const err = (await rejection(fetchUserInfo(fetchFn, github, 'stub-access-1'))) as Error;
    expect(err).toBeInstanceOf(OauthUnavailableError);
    expect(err.message).not.toContain('stub-access-1');
  });
});

describe('every vendor call is bounded', () => {
  const runs: Array<[string, (fetchFn: typeof fetch) => Promise<unknown>]> = [
    [
      'exchangeAuthorizationCode',
      (f) =>
        exchangeAuthorizationCode(f, {
          tokenUrl: TOKEN_URL,
          client: CLIENT,
          code: 'c',
          redirectUri: REDIRECT,
          verifier: 'v',
        }),
    ],
    [
      'refreshAccessToken',
      (f) => refreshAccessToken(f, { tokenUrl: TOKEN_URL, client: CLIENT, refreshToken: 'r' }),
    ],
    [
      'revokeToken',
      (f) =>
        revokeToken(f, {
          revokeUrl: REVOKE_URL,
          client: CLIENT,
          token: 't',
          tokenTypeHint: 'access_token',
        }),
    ],
    [
      'startDeviceAuthorization',
      (f) =>
        startDeviceAuthorization(f, {
          deviceCodeUrl: DEVICE_URL,
          clientId: 'stub-client-id',
          scopes: [],
        }),
    ],
    [
      'pollDeviceToken',
      (f) =>
        pollDeviceToken(f, { tokenUrl: TOKEN_URL, client: CLIENT, deviceCode: 'd', interval: 5 }),
    ],
    [
      'fetchUserInfo',
      (f) =>
        fetchUserInfo(
          f,
          { url: 'https://api.example.com/user', idPointer: '/id', labelPointer: '/login' },
          'a',
        ),
    ],
  ];
  const ANY_BODY = {
    ...TOKENS,
    device_code: 'd',
    user_code: 'u',
    verification_uri: 'https://auth.example.com/device',
    id: 1,
    login: 'octocat',
  };

  it('has a timeout of at most 30 seconds', () => {
    expect(VENDOR_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(VENDOR_CALL_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it.each(runs)('%s carries a live AbortSignal built from that timeout', async (_name, run) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchFn, calls } = stub(() => json(200, ANY_BODY));
    await run(fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(VENDOR_CALL_TIMEOUT_MS);
  });

  it.each(runs)('%s does not follow a redirect with its secrets', async (_name, run) => {
    const { fetchFn, calls } = stub(() => json(200, ANY_BODY));
    await run(fetchFn);
    expect(calls[0]?.redirect).toBe('error');
  });
});

describe('the provider registry', () => {
  it('lists the five core forges for now', () => {
    expect(listIntegrationProviders().map((p) => p.id)).toEqual([
      'github',
      'gitea',
      'gitlab',
      'bitbucket_cloud',
      'bitbucket_server',
    ]);
  });

  it('looks a provider up by id', () => {
    expect(getIntegrationProvider('github')?.displayName).toBe('GitHub');
    expect(getIntegrationProvider('nope')).toBeUndefined();
  });
});

describe('connection token envelope', () => {
  const tokens = { accessToken: 'stub-access-1', refreshToken: 'stub-refresh-1' };

  it('stores neither token in the clear and reads both back', () => {
    const columns = encryptConnectionTokens(tokens, KEK);
    for (const stored of [
      columns.accessTokenEncrypted,
      columns.refreshTokenEncrypted,
      columns.encryptedDek,
    ]) {
      expect(stored).toBeTypeOf('string');
      expect(stored).not.toContain('stub-access-1');
      expect(stored).not.toContain('stub-refresh-1');
    }
    expect(columns.accessTokenEncrypted).not.toBe(tokens.accessToken);
    expect(columns.refreshTokenEncrypted).not.toBe(tokens.refreshToken);
    expect(decryptConnectionTokens(columns, KEK)).toEqual(tokens);
  });

  it('decrypts under the row DEK that the KEK wraps, with the stock primitives', () => {
    const columns = encryptConnectionTokens(tokens, KEK);
    const dek = decryptDek(columns.encryptedDek, KEK);
    expect(decrypt(columns.accessTokenEncrypted, dek)).toBe('stub-access-1');
    expect(decrypt(columns.refreshTokenEncrypted as string, dek)).toBe('stub-refresh-1');
  });

  it('uses a new DEK and new ciphertext on every write', () => {
    const a = encryptConnectionTokens(tokens, KEK);
    const b = encryptConnectionTokens(tokens, KEK);
    expect(a.encryptedDek).not.toBe(b.encryptedDek);
    expect(a.accessTokenEncrypted).not.toBe(b.accessTokenEncrypted);
  });

  it('keeps a missing refresh token missing', () => {
    const columns = encryptConnectionTokens(
      { accessToken: 'stub-access-1', refreshToken: null },
      KEK,
    );
    expect(columns.refreshTokenEncrypted).toBeNull();
    expect(decryptConnectionTokens(columns, KEK).refreshToken).toBeNull();
  });

  it('does not decrypt under another KEK', () => {
    const columns = encryptConnectionTokens(tokens, KEK);
    expect(() => decryptConnectionTokens(columns, 'cd'.repeat(32))).toThrow();
  });

  it('refuses a row that holds no access token', () => {
    expect(() =>
      decryptConnectionTokens(
        { accessTokenEncrypted: null, refreshTokenEncrypted: null, encryptedDek: null },
        KEK,
      ),
    ).toThrow();
  });
});
