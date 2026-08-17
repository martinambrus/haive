import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyGrokRefresh,
  grokTokenNeedsRefresh,
  parseGrokAuthFile,
  refreshGrokToken,
} from './grok-oauth.js';

// The EXACT shape read off the live user auth volume (haive_cli_auth_..._grok_0) in the
// incident this module exists for — a 6-hour token that had already lapsed, whose spent
// refresh token made grok answer "Not signed in" and delete the file. Nanosecond-precision
// RFC 3339 and the "<issuer>::<client_id>" entry key are both grok's own, not invented.
const REAL_AUTH_JSON = JSON.stringify({
  'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
    key: 'eyJhbGciOiJFUzI1NiJ9.payload.sig',
    auth_mode: 'oidc',
    create_time: '2026-08-17T06:21:40.847755288Z',
    user_id: '783a49a9-8a65-44bf-a7d7-5274d40aadf7',
    email: 'someone@example.com',
    coding_data_retention_opt_out: true,
    refresh_token: 'rt-original',
    expires_at: '2026-08-17T12:21:40.847755288Z',
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
  },
});
const EXPIRES_AT_MS = Date.parse('2026-08-17T12:21:40.847755288Z');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseGrokAuthFile', () => {
  it('reads the token, refresh token, client id and expiry off the real file shape', () => {
    const cred = parseGrokAuthFile(REAL_AUTH_JSON);
    expect(cred).not.toBeNull();
    expect(cred?.entryKey).toBe('https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828');
    expect(cred?.accessToken).toBe('eyJhbGciOiJFUzI1NiJ9.payload.sig');
    expect(cred?.refreshToken).toBe('rt-original');
    expect(cred?.clientId).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(cred?.expiresAtMs).toBe(EXPIRES_AT_MS);
  });

  // Every null here means "leave the credential alone", which is always survivable. A
  // false positive is not: it would rewrite a file we did not understand.
  it.each([
    ['unparseable json', 'not json at all'],
    ['an empty object', '{}'],
    ['a json array', '[]'],
    ['an entry with no refresh token', '{"https://auth.x.ai::c":{"key":"k","oidc_client_id":"c"}}'],
    ['an entry with no client id', '{"https://auth.x.ai::c":{"key":"k","refresh_token":"r"}}'],
    [
      'an entry with no access token',
      '{"https://auth.x.ai::c":{"refresh_token":"r","oidc_client_id":"c"}}',
    ],
  ])('returns null for %s', (_label, raw) => {
    expect(parseGrokAuthFile(raw)).toBeNull();
  });

  it('tolerates an unreadable expires_at by reporting an unknown expiry, not an expired one', () => {
    const raw =
      '{"https://auth.x.ai::c":{"key":"k","refresh_token":"r","oidc_client_id":"c","expires_at":"whenever"}}';
    expect(parseGrokAuthFile(raw)?.expiresAtMs).toBeNull();
  });
});

describe('grokTokenNeedsRefresh', () => {
  it('is due inside the 30-minute skew and after expiry', () => {
    expect(grokTokenNeedsRefresh(EXPIRES_AT_MS, EXPIRES_AT_MS - 29 * 60_000)).toBe(true);
    expect(grokTokenNeedsRefresh(EXPIRES_AT_MS, EXPIRES_AT_MS)).toBe(true);
    expect(grokTokenNeedsRefresh(EXPIRES_AT_MS, EXPIRES_AT_MS + 60 * 60_000)).toBe(true);
  });

  it('is not due outside the skew', () => {
    expect(grokTokenNeedsRefresh(EXPIRES_AT_MS, EXPIRES_AT_MS - 31 * 60_000)).toBe(false);
  });

  // An unknown expiry is not evidence of a dying token, and the refresh token is
  // single-use — spending it on a guess costs the login.
  it('is not due when the expiry is unknown', () => {
    expect(grokTokenNeedsRefresh(null, Date.now())).toBe(false);
  });
});

describe('refreshGrokToken', () => {
  it('posts an RFC 6749 form-encoded refresh grant to the xAI token endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 21600 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const fresh = await refreshGrokToken('rt-original', 'client-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://auth.x.ai/oauth2/token');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt-original');
    expect(body.get('client_id')).toBe('client-abc');
    // Public client: sending a secret we do not have would be rejected outright.
    expect(body.get('client_secret')).toBeNull();
    expect(fresh.accessToken).toBe('at-new');
    expect(fresh.refreshToken).toBe('rt-new');
  });

  // xAI rotates the refresh token, but a response that omits one means the old one is
  // still current. Dropping it there would leave nothing to renew with next time.
  it('keeps the prior refresh token when the response omits a rotated one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'at-new' }) })),
    );
    const fresh = await refreshGrokToken('rt-original', 'client-abc');
    expect(fresh.refreshToken).toBe('rt-original');
  });

  // The caller substring-matches invalid_grant on this message to tell a permanent
  // rejection from a transient one, so the body has to survive into the error.
  it('throws with the response body so invalid_grant stays detectable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant","error_description":"token is expired"}',
      })),
    );
    await expect(refreshGrokToken('rt-dead', 'client-abc')).rejects.toThrow(/invalid_grant/);
  });

  it('throws when the endpoint answers 200 with no access token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ refresh_token: 'rt-new' }) })),
    );
    await expect(refreshGrokToken('rt-original', 'client-abc')).rejects.toThrow(/no access_token/);
  });
});

describe('applyGrokRefresh', () => {
  it('rewrites only the credential fields and preserves everything else', () => {
    const cred = parseGrokAuthFile(REAL_AUTH_JSON)!;
    const now = Date.parse('2026-08-17T14:00:00.000Z');
    const out = applyGrokRefresh(
      cred,
      { accessToken: 'at-new', refreshToken: 'rt-new', expiresAtMs: now + 6 * 3600_000 },
      now,
    );

    const entry = (JSON.parse(out) as Record<string, Record<string, unknown>>)[cred.entryKey]!;
    expect(entry['key']).toBe('at-new');
    expect(entry['refresh_token']).toBe('rt-new');
    expect(entry['expires_at']).toBe('2026-08-17T20:00:00.000Z');
    expect(entry['create_time']).toBe('2026-08-17T14:00:00.000Z');
    // Untouched identity fields — grok reads these back and a drop would look like a
    // different account.
    expect(entry['oidc_client_id']).toBe('b1a00492-073a-47ea-816f-4c329264a828');
    expect(entry['oidc_issuer']).toBe('https://auth.x.ai');
    expect(entry['auth_mode']).toBe('oidc');
    expect(entry['user_id']).toBe('783a49a9-8a65-44bf-a7d7-5274d40aadf7');
    expect(entry['coding_data_retention_opt_out']).toBe(true);
    // The result must round-trip through parse, or the next tick cannot renew it.
    expect(parseGrokAuthFile(out)?.refreshToken).toBe('rt-new');
  });

  it('keeps sibling entries of a multi-issuer file', () => {
    const multi = JSON.stringify({
      'https://auth.x.ai::c1': {
        key: 'k1',
        refresh_token: 'r1',
        oidc_client_id: 'c1',
        expires_at: '2026-08-17T12:21:40Z',
      },
      'https://sso.example.com::c2': { key: 'k2', refresh_token: 'r2', oidc_client_id: 'c2' },
    });
    const cred = parseGrokAuthFile(multi)!;
    const out = JSON.parse(
      applyGrokRefresh(cred, { accessToken: 'k1b', refreshToken: 'r1b', expiresAtMs: 0 }),
    ) as Record<string, Record<string, unknown>>;
    expect(out['https://sso.example.com::c2']?.['key']).toBe('k2');
    expect(out['https://auth.x.ai::c1']?.['key']).toBe('k1b');
  });
});
