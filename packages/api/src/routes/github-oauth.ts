import { Hono } from 'hono';
import { z } from 'zod';
import { schema } from '@haive/database';
import { encrypt, encryptDek, generateDek, secretsService, userSecretsService } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const pollSchema = z.object({
  deviceCode: z.string().min(1).max(512),
});

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenError {
  error: string;
  error_description?: string;
}

interface AccessTokenSuccess {
  access_token: string;
  token_type: string;
  scope: string;
}

type AccessTokenResponse = AccessTokenError | AccessTokenSuccess;

interface GithubUser {
  login: string;
  id: number;
}

export type FetchFn = typeof fetch;

const PENDING_ERRORS = new Set(['authorization_pending', 'slow_down']);

export async function startDeviceCode(
  fetchFn: FetchFn,
  clientId: string,
): Promise<DeviceCodeResponse> {
  const res = await fetchFn('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'haive',
    },
    body: new URLSearchParams({ client_id: clientId, scope: 'repo' }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new HttpError(502, `GitHub device-code request failed (HTTP ${res.status}): ${errBody}`);
  }
  const body = (await res.json()) as DeviceCodeResponse;
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw new HttpError(502, 'GitHub device-code response malformed');
  }
  return body;
}

export async function pollAccessToken(
  fetchFn: FetchFn,
  clientId: string,
  deviceCode: string,
): Promise<AccessTokenResponse> {
  const res = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'haive',
    },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new HttpError(502, `GitHub token-exchange failed (HTTP ${res.status}): ${errBody}`);
  }
  return (await res.json()) as AccessTokenResponse;
}

export async function fetchGithubUser(fetchFn: FetchFn, token: string): Promise<GithubUser> {
  const res = await fetchFn('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'haive',
    },
  });
  if (!res.ok) {
    throw new HttpError(502, `GitHub /user failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as GithubUser;
  if (!body.login) throw new HttpError(502, 'GitHub /user response missing login');
  return body;
}

export function isPendingError(tokenRes: AccessTokenResponse): tokenRes is AccessTokenError {
  return 'error' in tokenRes && PENDING_ERRORS.has(tokenRes.error);
}

async function resolveClientId(userId: string): Promise<string | null> {
  const fromEnv = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const stored = await userSecretsService.get(userId, 'github_client_id');
    return stored && stored.trim().length > 0 ? stored.trim() : null;
  } catch {
    return null;
  }
}

export const githubOauthRoutes = new Hono<AppEnv>();
githubOauthRoutes.use('*', requireAuth);

githubOauthRoutes.post('/device-code', async (c) => {
  const userId = c.get('userId');
  const clientId = await resolveClientId(userId);
  if (!clientId) {
    throw new HttpError(503, 'GitHub OAuth is not configured on this server');
  }
  const response = await startDeviceCode(fetch, clientId);
  return c.json({
    deviceCode: response.device_code,
    userCode: response.user_code,
    verificationUri: response.verification_uri,
    expiresIn: response.expires_in,
    interval: response.interval,
  });
});

githubOauthRoutes.post('/poll', async (c) => {
  const userId = c.get('userId');
  const body = pollSchema.parse(await c.req.json());
  const clientId = await resolveClientId(userId);
  if (!clientId) {
    throw new HttpError(503, 'GitHub OAuth is not configured on this server');
  }

  const tokenRes = await pollAccessToken(fetch, clientId, body.deviceCode);
  if ('error' in tokenRes) {
    if (PENDING_ERRORS.has(tokenRes.error)) {
      return c.json({ status: 'pending', error: tokenRes.error });
    }
    throw new HttpError(400, tokenRes.error_description ?? tokenRes.error);
  }

  const user = await fetchGithubUser(fetch, tokenRes.access_token);
  const db = getDb();
  const masterKek = await secretsService.getMasterKek();
  const dekHex = generateDek();
  const usernameEncrypted = encrypt(user.login, dekHex);
  const secretEncrypted = encrypt(tokenRes.access_token, dekHex);
  const encryptedDek = encryptDek(dekHex, masterKek);

  const inserted = await db
    .insert(schema.repoCredentials)
    .values({
      userId,
      label: `GitHub OAuth (${user.login})`,
      host: 'github.com',
      usernameEncrypted,
      secretEncrypted,
      encryptedDek,
    })
    .returning({
      id: schema.repoCredentials.id,
      label: schema.repoCredentials.label,
      host: schema.repoCredentials.host,
    });

  return c.json({ status: 'ok', credential: inserted[0] });
});
