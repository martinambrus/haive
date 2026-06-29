import { createHash, randomBytes } from 'node:crypto';

/**
 * Claude Code OAuth (Authorization-Code + PKCE) — mints a `user:profile`-scoped
 * token for reading GET https://api.anthropic.com/api/oauth/usage.
 *
 * Why this exists: Haive authenticates claude for RUNNING it via `claude setup-token`,
 * which is `user:inference`-only by design and always 403s on the usage endpoint
 * ("OAuth token does not meet scope requirement user:profile"). The scoped token can
 * only come from the interactive `/login` flow or — as here — by replicating its PKCE
 * exchange ourselves. This module is pure HTTP + node:crypto: no container, no claude
 * binary, no TUI driving (the CLI's headless paste-code screen is documented as buggy).
 *
 * SERVER-ONLY. Uses node:crypto + fetch. NOT exported from the shared browser barrel
 * (would pull node:crypto into the web bundle). Imported via `@haive/shared/claude-oauth`.
 *
 * VOLATILE — every constant below is reverse-engineered from the claude CLI and
 * corroborated across multiple OSS reimplementations (grll/claude-code-login et al.).
 * Anthropic can change them silently; if they drift the usage fetch fails and the chip
 * hides (fail-loud). Keep each pinned here, marked volatile, easy to flip.
 */

// The public client_id baked into the claude CLI (independently hardcoded in 6+ OSS repos).
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Subscription (Max/Pro) authorize host. (Console/API-key accounts use console.anthropic.com.)
const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
// Token endpoint migrated console.anthropic.com -> platform.claude.com (the legacy host
// now 500s on Claude-Code-flow refreshes). If exchange/refresh starts failing, this host
// + CLAUDE_OAUTH_REDIRECT_URI are the first suspects.
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// MUST include user:profile (the scope the usage endpoint enforces). The full set drifts
// across CLI releases (2->3->4->5 scopes); we request the canonical 3 and only assert
// membership of user:profile, never an exact-array match.
const CLAUDE_OAUTH_SCOPE = 'org:create_api_key user:profile user:inference';
const REQUIRED_USAGE_SCOPE = 'user:profile';

/** cli_provider_secret name holding the JSON-serialized ClaudeOauthTokens minted by
 *  this PKCE flow (distinct from CLAUDE_CODE_OAUTH_TOKEN, the setup-token used to RUN
 *  claude). Shared by the api writer (on connect/refresh) and the worker poller (read). */
export const CLAUDE_USAGE_OAUTH_SECRET = 'CLAUDE_USAGE_OAUTH';
// Access tokens are short-lived (~8h). Refresh a bit early to absorb clock skew + the
// poll cadence so a fetch never races the boundary.
const CLAUDE_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface ClaudeOauthTokens {
  accessToken: string;
  /** Single-use / rotated on every refresh — always persist the newest one. */
  refreshToken: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

export interface ClaudePkceChallenge {
  verifier: string;
  challenge: string;
  state: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Fresh PKCE verifier/challenge (S256) + anti-forgery state for one authorize round. */
export function createClaudePkceChallenge(): ClaudePkceChallenge {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

/** Authorize URL the user opens in their own browser; `code=true` makes the callback
 *  page render the result as `code#state` for them to copy-paste back. */
export function buildClaudeAuthorizeUrl(challenge: string, state: string): string {
  const u = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  u.searchParams.set('code', 'true');
  u.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', CLAUDE_OAUTH_REDIRECT_URI);
  u.searchParams.set('scope', CLAUDE_OAUTH_SCOPE);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}

/** The callback shows `code#state`; the user pastes the whole thing. Tolerate a bare code. */
export function parseClaudeAuthCode(pasted: string): { code: string; state: string | null } {
  const trimmed = pasted.trim();
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) return { code: trimmed, state: null };
  return { code: trimmed.slice(0, hashIdx), state: trimmed.slice(hashIdx + 1) || null };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function toTokens(j: TokenResponse, fallbackRefresh?: string): ClaudeOauthTokens {
  if (!j.access_token) throw new Error('claude oauth: response had no access_token');
  return {
    accessToken: j.access_token,
    // refresh_token rotates; if the response omits it, keep the prior one.
    refreshToken: j.refresh_token ?? fallbackRefresh ?? '',
    expiresAt: Date.now() + (j.expires_in ?? 28800) * 1000,
    scopes: (j.scope ?? '').split(/\s+/).filter(Boolean),
  };
}

export function claudeTokensHaveUsageScope(t: ClaudeOauthTokens): boolean {
  return t.scopes.includes(REQUIRED_USAGE_SCOPE);
}

export function claudeTokenNeedsRefresh(expiresAt: number, now = Date.now()): boolean {
  return now >= expiresAt - CLAUDE_TOKEN_REFRESH_SKEW_MS;
}

// OAuth2 token endpoints are form-encoded per RFC 6749. (Some OSS impls POST JSON and it
// also works; the body PARAMS are the invariant, the content-type is the volatile bit.)
async function postToken(params: Record<string, string>): Promise<ClaudeOauthTokens> {
  const res = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`claude oauth ${params.grant_type}: http ${res.status} ${body.slice(0, 200)}`);
  }
  const prior = params.grant_type === 'refresh_token' ? params.refresh_token : undefined;
  return toTokens((await res.json()) as TokenResponse, prior);
}

/** Exchange the pasted authorization code for the first token pair. */
export function exchangeClaudeAuthCode(
  code: string,
  verifier: string,
  state: string | null,
): Promise<ClaudeOauthTokens> {
  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    code_verifier: verifier,
    ...(state ? { state } : {}),
  });
}

/** Renew an expiring access token. Scope (incl. user:profile) is preserved; no scope
 *  param is sent so it can never narrow. Caller MUST persist the rotated refresh token. */
export function refreshClaudeToken(refreshToken: string): Promise<ClaudeOauthTokens> {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  });
}
