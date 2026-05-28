import { createHmac, timingSafeEqual } from 'node:crypto';

/** Task-scoped bearer token for the haive-rag MCP proxy -> API path.
 *
 *  The token is minted server-side (worker, when wiring the per-task MCP
 *  config) and handed to the sandbox via the MCP server's env. The sandbox
 *  presents it to `POST /rag/search`; the API verifies it and trusts the
 *  embedded taskId. This lets a sandbox query ONLY its own task's project
 *  without ever holding a user session or DB credentials.
 *
 *  Format: `<base64url(payload)>.<base64url(hmac-sha256(payload))>` where
 *  payload is `{ taskId, exp }` (exp = unix seconds). Signed with a server
 *  secret (CONFIG_ENCRYPTION_KEY) that the sandbox never sees. */

interface RagTokenPayload {
  taskId: string;
  exp: number;
}

export const DEFAULT_RAG_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function signRagToken(
  taskId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_RAG_TOKEN_TTL_SECONDS,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ taskId, exp } satisfies RagTokenPayload)).toString(
    'base64url',
  );
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyRagToken(token: string, secret: string): { taskId: string } | null {
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
    ) as RagTokenPayload;
    if (typeof decoded.taskId !== 'string' || typeof decoded.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) > decoded.exp) return null;
    return { taskId: decoded.taskId };
  } catch {
    return null;
  }
}
