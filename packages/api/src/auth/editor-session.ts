import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { parse } from 'hono/utils/cookie';
import { setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { secretsService } from '@haive/shared';
import { isCanonicalUuid } from '../lib/uuid.js';
import { ideTarget } from '../lib/ide-target.js';
import { editorOrigin } from '../lib/request-origin.js';
import { HttpError } from '../context.js';
import { requireSessionUser } from '../middleware/auth.js';

export const EDITOR_SESSION_TTL = 8 * 3600;
export const editorTargetSchema = z.object({
  kind: z.enum(['task', 'repo']),
  id: z.string().refine(isCanonicalUuid),
});
export type EditorTarget = z.infer<typeof editorTargetSchema>;
const claimsSchema = z.object({
  sub: z.string().refine(isCanonicalUuid),
  tv: z.number().int().nonnegative(),
  target: editorTargetSchema,
  runtimeSessionId: z.string(),
  editorOrigin: z.string(),
  exp: z.number(),
});
export type EditorSessionPayload = Omit<z.infer<typeof claimsSchema>, 'exp'>;

async function signingKey(): Promise<Buffer> {
  return createHmac('sha256', await secretsService.getJwtSecret())
    .update('haive-editor-session-v1')
    .digest();
}

export async function signEditorSession(payload: EditorSessionPayload): Promise<string> {
  return jwt.sign(payload, await signingKey(), {
    algorithm: 'HS256',
    expiresIn: EDITOR_SESSION_TTL,
  });
}

export async function verifyEditorSession(token: string): Promise<EditorSessionPayload> {
  return claimsSchema.parse(jwt.verify(token, await signingKey(), { algorithms: ['HS256'] }));
}

export function editorCookieName(target: EditorTarget): string {
  return `haive_editor_${target.kind}_${target.id}`;
}

export function editorCookieFromHeader(
  header: string | undefined,
  target: EditorTarget,
): string | undefined {
  return parse(header ?? '', editorCookieName(target))[editorCookieName(target)];
}

export function setEditorCookie(c: Context, payload: EditorSessionPayload, token: string): void {
  const secure = new URL(payload.editorOrigin).protocol === 'https:';
  setCookie(c, editorCookieName(payload.target), token, {
    httpOnly: true,
    path: `${ideTarget(payload.target.id, payload.sub, payload.target.kind === 'repo').prefix}/`,
    maxAge: EDITOR_SESSION_TTL,
    secure,
    sameSite: secure ? 'None' : 'Lax',
    ...(secure ? { partitioned: true } : {}),
  });
}

export function editorClaimsMatch(payload: EditorSessionPayload, target: EditorTarget): boolean {
  return (
    payload.target.kind === target.kind &&
    payload.target.id === target.id &&
    payload.runtimeSessionId ===
      ideTarget(target.id, payload.sub, target.kind === 'repo').sessionId &&
    payload.editorOrigin === editorOrigin()
  );
}

/** Reuse the app's active/version/password policy, but never cause an app refresh retry. */
export async function requireEditorUser(userId: string, tv: number) {
  try {
    return await requireSessionUser(userId, tv);
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(403, 'Editor access refused');
    throw err;
  }
}
