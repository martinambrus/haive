/**
 * grok (xAI) OIDC refresh — renews the access token in `~/.grok/auth.json` without a
 * re-login.
 *
 * Why this exists: grok's stored credential is a ~6-hour access token plus a ROTATING
 * refresh token. The CLI refreshes it in place, but Haive runs the CLI against a per-task
 * COPY of the auth volume, so that refresh lands in a volume destroyed at teardown. The
 * user volume is then left holding a spent refresh token and an expired access token,
 * grok answers "Not signed in" and DELETES auth.json — measured on a real login that died
 * six hours after it was made. Carrying the task copy back
 * (syncRefreshedAuthToUserVolumes) covers a task that ends cleanly; this covers the rest:
 * an idle account, and a worker killed mid-teardown.
 *
 * grok exposes no refresh subcommand (`login --oauth` / `login --device-auth` / `logout`
 * / `models` only), so the grant has to be made directly. Modelled on
 * `@haive/shared/claude-oauth`; kept worker-local because only the worker needs it.
 *
 * VOLATILE — GROK_TOKEN_URL is read from xAI's OIDC discovery document
 * (https://auth.x.ai/.well-known/openid-configuration), measured 2026-08-17, which
 * advertises `refresh_token` in grant_types_supported and `none` in
 * token_endpoint_auth_methods_supported (a PUBLIC client, so no client secret). If xAI
 * moves the endpoint, refreshes fail loudly here rather than degrading silently, and this
 * constant is the first suspect. The client_id is NOT pinned: it is read from the stored
 * credential's own `oidc_client_id`, so an enterprise issuer works unchanged.
 */

const GROK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';

/** Refresh this far ahead of expiry. Generous (vs claude's 5 min) because the sweep that
 *  calls this yields to any running task, so it may have to wait several poll ticks for a
 *  window in which it is safe to rotate. */
const GROK_TOKEN_REFRESH_SKEW_MS = 30 * 60 * 1000;

/** grok's own field names inside `auth.json`. Its access token is `key`, not
 *  `access_token` — the file is grok's cache format, not an OAuth token response. */
const ENTRY_ACCESS_TOKEN = 'key';
const ENTRY_REFRESH_TOKEN = 'refresh_token';
const ENTRY_CLIENT_ID = 'oidc_client_id';
const ENTRY_EXPIRES_AT = 'expires_at';
const ENTRY_CREATE_TIME = 'create_time';

export interface GrokStoredCredential {
  /** The `"<oidc_issuer>::<oidc_client_id>"` key this entry lives under. Writing back must
   *  reuse it verbatim — grok looks the entry up by exactly that string. */
  entryKey: string;
  accessToken: string;
  refreshToken: string;
  clientId: string;
  /** Epoch ms, or null when the file carries no parseable `expires_at`. */
  expiresAtMs: number | null;
  /** The whole parsed file, so a rewrite preserves sibling entries and unknown fields. */
  file: Record<string, unknown>;
}

export interface GrokRefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Pull the first refreshable OIDC entry out of a raw `auth.json`, or null when the file
 *  is unparseable, empty, api-key-mode, or missing the fields a refresh needs. Returning
 *  null always means "leave it alone", never "it is broken" — an untouched credential is
 *  always survivable, a clobbered one is not. */
export function parseGrokAuthFile(rawJson: string): GrokStoredCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  const file = rec(parsed);
  if (!file) return null;

  for (const [entryKey, value] of Object.entries(file)) {
    const entry = rec(value);
    if (!entry) continue;
    const accessToken = str(entry[ENTRY_ACCESS_TOKEN]);
    const refreshToken = str(entry[ENTRY_REFRESH_TOKEN]);
    const clientId = str(entry[ENTRY_CLIENT_ID]);
    if (!accessToken || !refreshToken || !clientId) continue;
    const rawExpiry = str(entry[ENTRY_EXPIRES_AT]);
    // grok writes RFC 3339 with NANOSECOND precision ("...:40.847755288Z"); Date.parse
    // accepts it and truncates to ms. A value it cannot read yields null, which the caller
    // treats as "expiry unknown" rather than "expired".
    const parsedExpiry = rawExpiry ? Date.parse(rawExpiry) : NaN;
    return {
      entryKey,
      accessToken,
      refreshToken,
      clientId,
      expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : null,
      file,
    };
  }
  return null;
}

/** True when the access token is inside the refresh window. A null expiry is NOT treated
 *  as due: without a readable timestamp there is no evidence the token is near death, and
 *  a needless rotation spends the single-use refresh token for nothing. */
export function grokTokenNeedsRefresh(expiresAtMs: number | null, now = Date.now()): boolean {
  if (expiresAtMs === null) return false;
  return now >= expiresAtMs - GROK_TOKEN_REFRESH_SKEW_MS;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Renew an expiring access token. OAuth2 token endpoints are form-encoded per RFC 6749.
 *  The caller MUST persist the returned refresh token: xAI rotates it, so the one passed
 *  in is dead the moment this resolves. */
export async function refreshGrokToken(
  refreshToken: string,
  clientId: string,
): Promise<GrokRefreshedTokens> {
  const res = await fetch(GROK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The body carries the OAuth error code; callers substring-match `invalid_grant` on
    // this message to tell "permanently rejected" from "try again later".
    throw new Error(`grok oauth refresh_token: http ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) throw new Error('grok oauth: response had no access_token');
  return {
    accessToken: json.access_token,
    // If the response omits a rotated token the old one is still current; keeping it is
    // the only way the next refresh can succeed.
    refreshToken: json.refresh_token ?? refreshToken,
    // 21600s (6h) is what xAI has issued; only a fallback for a response that omits it.
    expiresAtMs: Date.now() + (json.expires_in ?? 21600) * 1000,
  };
}

/** Serialize the refreshed pair back into grok's own file format, preserving every other
 *  field and sibling entry. Returned as text so the caller can write it atomically. */
export function applyGrokRefresh(
  cred: GrokStoredCredential,
  fresh: GrokRefreshedTokens,
  now = Date.now(),
): string {
  const entry = { ...(rec(cred.file[cred.entryKey]) ?? {}) };
  entry[ENTRY_ACCESS_TOKEN] = fresh.accessToken;
  entry[ENTRY_REFRESH_TOKEN] = fresh.refreshToken;
  entry[ENTRY_EXPIRES_AT] = new Date(fresh.expiresAtMs).toISOString();
  entry[ENTRY_CREATE_TIME] = new Date(now).toISOString();
  return `${JSON.stringify({ ...cred.file, [cred.entryKey]: entry }, null, 2)}\n`;
}
