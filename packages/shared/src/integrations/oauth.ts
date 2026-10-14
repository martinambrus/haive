import { createHash, randomBytes } from 'node:crypto';
import type { UserInfoSpec } from '../modularity/integrations.js';
import { OauthUnavailableError, OauthVendorError } from './errors.js';

export const VENDOR_CALL_TIMEOUT_MS = 15_000;

const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
const DEVICE_SLOW_DOWN_SECONDS = 5;
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DESCRIPTION_MAX_LENGTH = 500;
const MIN_REDACTED_LENGTH = 8;

export interface OauthClientCredentials {
  clientId: string;
  clientSecret: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  /** null when the provider sent no `scope`: it granted what was asked (RFC 6749 5.1). */
  scopes: string[] | null;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  { status: 'pending'; interval: number } | { status: 'complete'; tokens: TokenSet };

type FetchFn = typeof fetch;
type Json = Record<string, unknown>;

interface VendorRequest {
  operation: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  form?: Record<string, string>;
  secrets: readonly (string | null | undefined)[];
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(text: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function redact(text: string, secrets: VendorRequest['secrets']): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= MIN_REDACTED_LENGTH) out = out.split(secret).join('[redacted]');
  }
  return out;
}

async function callVendor(fetchFn: FetchFn, request: VendorRequest): Promise<Json | null> {
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(request.url, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'haive',
        ...(request.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...request.headers,
      },
      body: request.form ? new URLSearchParams(request.form).toString() : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(VENDOR_CALL_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error';
    throw new OauthUnavailableError(`${request.operation} request failed (${name})`, {
      cause: err,
    });
  }
  if (res.status >= 500) {
    throw new OauthUnavailableError(`${request.operation} failed (HTTP ${res.status})`);
  }
  const body = parseObject(text);
  if (body !== null && typeof body.error === 'string') {
    const raw = body.error_description;
    const description =
      typeof raw === 'string' && raw.length > 0
        ? redact(raw, request.secrets).slice(0, DESCRIPTION_MAX_LENGTH)
        : null;
    throw new OauthVendorError(request.operation, body.error, description, res.status);
  }
  if (!res.ok) {
    throw new OauthUnavailableError(`${request.operation} failed (HTTP ${res.status})`);
  }
  return body;
}

function positiveSeconds(raw: unknown): number | null {
  const seconds = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function toTokenSet(body: Json | null, nowMs: number, operation: string): TokenSet {
  const accessToken = body?.access_token;
  if (!body || typeof accessToken !== 'string' || accessToken === '') {
    throw new OauthUnavailableError(`${operation} returned no access token`);
  }
  const refreshToken = body.refresh_token;
  const lifetime = positiveSeconds(body.expires_in);
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
    expiresAt: lifetime === null ? null : new Date(nowMs + lifetime * 1000),
    scopes: typeof body.scope === 'string' ? body.scope.split(/[\s,]+/).filter(Boolean) : null,
  };
}

function clientForm(client: OauthClientCredentials): Record<string, string> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret === null ? {} : { client_secret: client.clientSecret }),
  };
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function buildAuthorizeUrl(input: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  if (input.scopes.length > 0) url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeAuthorizationCode(
  fetchFn: FetchFn,
  input: {
    tokenUrl: string;
    client: OauthClientCredentials;
    code: string;
    redirectUri: string;
    verifier: string;
    now?: () => number;
  },
): Promise<TokenSet> {
  const operation = 'token exchange';
  const body = await callVendor(fetchFn, {
    operation,
    url: input.tokenUrl,
    method: 'POST',
    form: {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      ...clientForm(input.client),
      code_verifier: input.verifier,
    },
    secrets: [input.code, input.verifier, input.client.clientSecret],
  });
  return toTokenSet(body, (input.now ?? Date.now)(), operation);
}

export async function refreshAccessToken(
  fetchFn: FetchFn,
  input: {
    tokenUrl: string;
    client: OauthClientCredentials;
    refreshToken: string;
    now?: () => number;
  },
): Promise<TokenSet> {
  const operation = 'token refresh';
  const body = await callVendor(fetchFn, {
    operation,
    url: input.tokenUrl,
    method: 'POST',
    form: {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      ...clientForm(input.client),
    },
    secrets: [input.refreshToken, input.client.clientSecret],
  });
  return toTokenSet(body, (input.now ?? Date.now)(), operation);
}

/** RFC 7009. False when the provider declares no revoke endpoint, so there was nothing to ask. */
export async function revokeToken(
  fetchFn: FetchFn,
  input: {
    revokeUrl: string | undefined;
    client: OauthClientCredentials;
    token: string;
    tokenTypeHint: 'access_token' | 'refresh_token';
  },
): Promise<boolean> {
  if (input.revokeUrl === undefined) return false;
  await callVendor(fetchFn, {
    operation: 'token revocation',
    url: input.revokeUrl,
    method: 'POST',
    form: { token: input.token, token_type_hint: input.tokenTypeHint, ...clientForm(input.client) },
    secrets: [input.token, input.client.clientSecret],
  });
  return true;
}

export async function startDeviceAuthorization(
  fetchFn: FetchFn,
  input: { deviceCodeUrl: string; clientId: string; scopes: readonly string[] },
): Promise<DeviceAuthorization> {
  const body = await callVendor(fetchFn, {
    operation: 'device authorization',
    url: input.deviceCodeUrl,
    method: 'POST',
    form: {
      client_id: input.clientId,
      ...(input.scopes.length > 0 ? { scope: input.scopes.join(' ') } : {}),
    },
    secrets: [],
  });
  const expiresIn = positiveSeconds(body?.expires_in);
  if (
    !body ||
    typeof body.device_code !== 'string' ||
    typeof body.user_code !== 'string' ||
    typeof body.verification_uri !== 'string' ||
    expiresIn === null
  ) {
    throw new OauthUnavailableError('device authorization returned an incomplete response');
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn,
    interval: positiveSeconds(body.interval) ?? DEFAULT_DEVICE_INTERVAL_SECONDS,
  };
}

/** One poll. `pending` carries the interval to wait before the next: longer after slow_down. */
export async function pollDeviceToken(
  fetchFn: FetchFn,
  input: {
    tokenUrl: string;
    client: OauthClientCredentials;
    deviceCode: string;
    interval: number;
    now?: () => number;
  },
): Promise<DevicePollResult> {
  const operation = 'device token poll';
  let body: Json | null;
  try {
    body = await callVendor(fetchFn, {
      operation,
      url: input.tokenUrl,
      method: 'POST',
      form: {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: input.deviceCode,
        ...clientForm(input.client),
      },
      secrets: [input.deviceCode, input.client.clientSecret],
    });
  } catch (err) {
    if (err instanceof OauthVendorError) {
      if (err.code === 'authorization_pending') {
        return { status: 'pending', interval: input.interval };
      }
      if (err.code === 'slow_down') {
        return { status: 'pending', interval: input.interval + DEVICE_SLOW_DOWN_SECONDS };
      }
    }
    throw err;
  }
  return { status: 'complete', tokens: toTokenSet(body, (input.now ?? Date.now)(), operation) };
}

function resolvePointer(document: unknown, pointer: string): unknown {
  let node = document;
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      node = /^(0|[1-9]\d*)$/.test(key) ? node[Number(key)] : undefined;
    } else if (isObject(node)) {
      node = Object.hasOwn(node, key) ? node[key] : undefined;
    } else {
      return undefined;
    }
  }
  return node;
}

export async function fetchUserInfo(
  fetchFn: FetchFn,
  userInfo: UserInfoSpec,
  accessToken: string,
): Promise<{ externalAccountId: string; accountLabel: string }> {
  const body = await callVendor(fetchFn, {
    operation: 'account lookup',
    url: userInfo.url,
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    secrets: [accessToken],
  });
  const id = resolvePointer(body, userInfo.idPointer);
  const label = resolvePointer(body, userInfo.labelPointer);
  const externalAccountId =
    typeof id === 'string' && id !== '' ? id : typeof id === 'number' ? String(id) : null;
  if (externalAccountId === null || typeof label !== 'string' || label === '') {
    throw new OauthUnavailableError('account lookup returned no account id or label');
  }
  return { externalAccountId, accountLabel: label };
}
