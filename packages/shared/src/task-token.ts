import { createHmac, timingSafeEqual } from 'node:crypto';

/** Audience-scoped bearer token a sandbox presents to the API on behalf of one task.
 *
 *  Format: `v1.<base64url(payload)>.<base64url(mac)>`, payload `{ aud, taskId, taskStepId?,
 *  cliInvocationId?, exp }` (exp = unix seconds). The MAC key is derived per audience from the
 *  server secret, so a token minted for one audience verifies under no other. Server-only: it
 *  needs the secret, which the sandbox never sees. */

export const TASK_TOKEN_AUDIENCES = ['rag', 'ddev', 'custom-mcp'] as const;
export type TaskTokenAudience = (typeof TASK_TOKEN_AUDIENCES)[number];

export const DEFAULT_TASK_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const TOKEN_VERSION = 'v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface TaskTokenPayload {
  aud: TaskTokenAudience;
  taskId: string;
  taskStepId?: string;
  cliInvocationId?: string;
  exp: number;
}

export interface TaskTokenClaims {
  aud: TaskTokenAudience;
  taskId: string;
  taskStepId?: string;
  cliInvocationId?: string;
  ttlSeconds?: number;
}

function isAudience(value: unknown): value is TaskTokenAudience {
  return TASK_TOKEN_AUDIENCES.includes(value as TaskTokenAudience);
}

function macFor(secret: string, aud: TaskTokenAudience, payload: string): string {
  const key = createHmac('sha256', secret).update(`haive-task-token:${aud}`).digest();
  return createHmac('sha256', key).update(`${TOKEN_VERSION}.${payload}`).digest('base64url');
}

export function signTaskToken(claims: TaskTokenClaims, secret: string): string {
  const { aud, taskId, taskStepId, cliInvocationId } = claims;
  if (!isAudience(aud)) throw new Error('unknown task token audience');
  const exp = Math.floor(Date.now() / 1000) + (claims.ttlSeconds ?? DEFAULT_TASK_TOKEN_TTL_SECONDS);
  const payload = Buffer.from(
    JSON.stringify({
      aud,
      taskId,
      ...(taskStepId === undefined ? {} : { taskStepId }),
      ...(cliInvocationId === undefined ? {} : { cliInvocationId }),
      exp,
    } satisfies TaskTokenPayload),
  ).toString('base64url');
  return `${TOKEN_VERSION}.${payload}.${macFor(secret, aud, payload)}`;
}

export function verifyTaskToken(
  token: string,
  aud: TaskTokenAudience,
  secret: string,
): TaskTokenPayload | null {
  if (!isAudience(aud)) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, payload, mac] = parts as [string, string, string];
  if (version !== TOKEN_VERSION || !BASE64URL.test(payload) || !BASE64URL.test(mac)) return null;
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(macFor(secret, aud, payload));
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  let decoded: Partial<TaskTokenPayload> | null;
  try {
    decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<TaskTokenPayload> | null;
  } catch {
    return null;
  }
  if (!decoded || decoded.aud !== aud) return null;
  const { taskId, taskStepId, cliInvocationId, exp } = decoded;
  if (typeof taskId !== 'string' || taskId === '') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (taskStepId !== undefined && typeof taskStepId !== 'string') return null;
  if (cliInvocationId !== undefined && typeof cliInvocationId !== 'string') return null;
  if (Math.floor(Date.now() / 1000) > exp) return null;
  return {
    aud,
    taskId,
    ...(taskStepId === undefined ? {} : { taskStepId }),
    ...(cliInvocationId === undefined ? {} : { cliInvocationId }),
    exp,
  };
}
