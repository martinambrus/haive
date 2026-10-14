import { createHmac, timingSafeEqual } from 'node:crypto';

/** Repo-scoped bearer token for the interactive terminal's git credential
 *  helper -> API path.
 *
 *  Minted server-side (worker, when spawning a repo-scope shell container) and
 *  handed to the container via env. The in-container git credential helper
 *  presents it to `POST /internal/git-credential`; the API verifies it, trusts
 *  the embedded repositoryId/userId, looks up the repo's bound credential, and
 *  returns username/password for that one push. The decrypted secret never
 *  lands in the container filesystem.
 *
 *  Format: `v1.<base64url(payload)>.<base64url(mac)>` where payload is
 *  `{ repositoryId, userId, exp }` (exp = unix seconds). The MAC key is derived for
 *  this purpose alone from a server secret (CONFIG_ENCRYPTION_KEY) the container never sees. */

interface GitCredTokenPayload {
  repositoryId: string;
  userId: string;
  exp: number;
}

export const DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS = 12 * 60 * 60;

const TOKEN_VERSION = 'v1';
const MAC_KEY_LABEL = 'haive-git-credential';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function macFor(secret: string, payload: string): string {
  const key = createHmac('sha256', secret).update(MAC_KEY_LABEL).digest();
  return createHmac('sha256', key).update(`${TOKEN_VERSION}.${payload}`).digest('base64url');
}

function claimsFrom(payload: string): { repositoryId: string; userId: string } | null {
  let decoded: Partial<GitCredTokenPayload> | null;
  try {
    decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<GitCredTokenPayload> | null;
  } catch {
    return null;
  }
  if (!decoded) return null;
  const { repositoryId, userId, exp } = decoded;
  if (typeof repositoryId !== 'string' || repositoryId === '') return null;
  if (typeof userId !== 'string' || userId === '') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  return { repositoryId, userId };
}

export function signRepoGitCredToken(
  repositoryId: string,
  userId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(
    JSON.stringify({ repositoryId, userId, exp } satisfies GitCredTokenPayload),
  ).toString('base64url');
  return `${TOKEN_VERSION}.${payload}.${macFor(secret, payload)}`;
}

export function verifyRepoGitCredToken(
  token: string,
  secret: string,
): { repositoryId: string; userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payload, mac] = parts as [string, string, string];
  if (version !== TOKEN_VERSION || !BASE64URL.test(payload) || !BASE64URL.test(mac)) return null;
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(macFor(secret, payload));
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  return claimsFrom(payload);
}

/** Terminals started before v1 hold the two-part, raw-secret form for up to 12 h; drop it then. */
export function verifyLegacyRepoGitCredToken(
  token: string,
  secret: string,
): { repositoryId: string; userId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  return claimsFrom(payload);
}
