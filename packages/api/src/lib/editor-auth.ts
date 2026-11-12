import type { IncomingMessage } from 'node:http';
import { HttpError } from '../context.js';
import {
  editorCookieFromHeader,
  editorClaimsMatch,
  verifyEditorSession,
  requireEditorUser,
  type EditorTarget,
  type EditorSessionPayload,
} from '../auth/editor-session.js';
import { trackUserUpgrade, type UpgradeSession } from './user-sockets.js';

export async function editorIdentity(
  cookie: string | undefined,
  target: EditorTarget,
): Promise<EditorSessionPayload | null> {
  const token = editorCookieFromHeader(cookie, target);
  if (token === undefined) return null;
  try {
    const payload = await verifyEditorSession(token);
    if (editorClaimsMatch(payload, target)) return payload;
  } catch {
    /* Invalid signature, expiry or claims. */
  }
  throw new HttpError(403, 'Invalid or expired editor session');
}

export async function authenticateEditorUpgrade(
  req: IncomingMessage,
  target: EditorTarget,
): Promise<{ userId: string; session: UpgradeSession } | null> {
  let session: UpgradeSession | undefined;
  try {
    const payload = await editorIdentity(req.headers.cookie, target);
    if (!payload) return null;
    // Fence before the user read, including revocations during any later await.
    session = trackUserUpgrade(payload.sub, req.socket);
    await requireEditorUser(payload.sub, payload.tv);
    if (session.revoked) return null;
    return { userId: payload.sub, session };
  } catch {
    if (!session?.revoked) session?.dispose();
    return null;
  }
}
