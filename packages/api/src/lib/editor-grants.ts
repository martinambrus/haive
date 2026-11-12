import { z } from 'zod';
import {
  editorTargetSchema,
  editorClaimsMatch,
  requireEditorUser,
  signEditorSession,
  setEditorCookie,
  type EditorSessionPayload,
} from '../auth/editor-session.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { HttpError, type AppEnv } from '../context.js';
import { getAccessCookie } from '../auth/cookies.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { getRedis } from '../redis.js';
import { requireSessionUser } from '../middleware/auth.js';
import { editorOrigin } from './request-origin.js';
import { ensureIde, ideTarget, targetBelongsToUser } from './ide-target.js';
import { isCanonicalUuid } from './uuid.js';

export interface EditorGrant {
  userId: string;
  tokenVersion: number;
  target: { kind: 'task' | 'repo'; id: string };
  runtimeSessionId: string;
  editorOrigin: string;
}

export function editorGrantKey(secret: string): string {
  return `editor-grant:${createHash('sha256').update(secret).digest('hex')}`;
}

export async function grantEditor(c: Context<AppEnv>, repository = false): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  const id = c.req.param('id');
  if (!id || !isCanonicalUuid(id)) throw new HttpError(404, 'Not found');
  const userId = c.get('userId');
  const target = ideTarget(id, userId, repository);
  if (!(await targetBelongsToUser(target))) throw new HttpError(404, 'Not found');
  if (!(await configService.getBoolean(CONFIG_KEYS.IDE_ENABLED, true))) {
    throw new HttpError(403, 'IDE disabled');
  }
  // The worker owns runtime resolution; only its ready result authorizes a grant.
  const ready = await ensureIde(target).then(
    (r) => r?.ok === true,
    () => false,
  );
  if (!ready) throw new HttpError(409, 'Editor is not ready');
  const origin = editorOrigin();
  if (!origin) throw new HttpError(503, 'The public API or editor origin must be configured');
  // Re-read after the ensure wait. No transaction/reserved DB connection crosses Redis.
  let user;
  try {
    const payload = await verifyAccessToken(getAccessCookie(c)!);
    user = await requireSessionUser(userId, payload.tv);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401)
      throw new HttpError(403, 'Editor access refused');
    throw err;
  }
  if (!(await targetBelongsToUser(target))) throw new HttpError(404, 'Not found');
  const secret = randomBytes(32).toString('base64url');
  const grant: EditorGrant = {
    userId,
    tokenVersion: user.tokenVersion,
    target: { kind: repository ? 'repo' : 'task', id },
    runtimeSessionId: target.sessionId,
    editorOrigin: origin,
  };
  await getRedis().set(editorGrantKey(secret), JSON.stringify(grant), 'PX', 60_000);
  return c.json({ url: `${origin}/ide/_handshake#${secret}` });
}

const grantSchema = z.object({
  userId: z.string().refine(isCanonicalUuid),
  tokenVersion: z.number().int().nonnegative(),
  target: editorTargetSchema,
  runtimeSessionId: z.string(),
  editorOrigin: z.string(),
});

export async function redeemEditor(c: Context<AppEnv>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  const refused = () =>
    new HttpError(403, 'Invalid or expired editor grant', 'invalid_editor_grant');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw refused();
  }
  const secret = z.object({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(body);
  if (!secret.success) throw refused();
  // GETDEL is the only take: two concurrent redemptions cannot both obtain the grant.
  const raw = await getRedis().getdel(editorGrantKey(secret.data.secret));
  if (!raw) throw refused();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw refused();
  }
  const grant = grantSchema.safeParse(value);
  if (!grant.success) throw refused();
  const g = grant.data;
  const payload: EditorSessionPayload = {
    sub: g.userId,
    tv: g.tokenVersion,
    target: g.target,
    runtimeSessionId: g.runtimeSessionId,
    editorOrigin: g.editorOrigin,
  };
  if (!editorClaimsMatch(payload, g.target)) throw refused();
  const origin = c.req.header('origin');
  if (origin !== undefined && origin !== g.editorOrigin) throw refused();
  await requireEditorUser(g.userId, g.tokenVersion);
  const target = ideTarget(g.target.id, g.userId, g.target.kind === 'repo');
  if (!(await targetBelongsToUser(target))) throw refused();
  const token = await signEditorSession(payload);
  setEditorCookie(c, payload, token);
  return c.json({ next: `${target.prefix}/` });
}
