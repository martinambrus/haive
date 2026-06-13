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
 *  Format: `<base64url(payload)>.<base64url(hmac-sha256(payload))>` where
 *  payload is `{ repositoryId, userId, exp }` (exp = unix seconds). Signed with
 *  a server secret (CONFIG_ENCRYPTION_KEY) the container never sees. */

interface GitCredTokenPayload {
  repositoryId: string;
  userId: string;
  exp: number;
}

export const DEFAULT_GIT_CRED_TOKEN_TTL_SECONDS = 12 * 60 * 60;

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
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyRepoGitCredToken(
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
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as GitCredTokenPayload;
    if (typeof decoded.repositoryId !== 'string' || typeof decoded.userId !== 'string') return null;
    if (typeof decoded.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) > decoded.exp) return null;
    return { repositoryId: decoded.repositoryId, userId: decoded.userId };
  } catch {
    return null;
  }
}
