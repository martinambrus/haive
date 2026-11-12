import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import { requireSessionUser } from '../middleware/auth.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { accessCookieFromHeader } from '../auth/cookies.js';
import { trackUserUpgrade, type UpgradeSession } from './user-sockets.js';

/** Session policy for every WebSocket surface. Ownership and origin stay with the caller. */
export async function authenticateUpgrade(
  req: IncomingMessage,
): Promise<{ userId: string; session: UpgradeSession } | null> {
  let session: UpgradeSession | undefined;
  try {
    const token = accessCookieFromHeader(req.headers.cookie);
    if (!token) return null;
    const payload = await verifyAccessToken(token);
    session = trackUserUpgrade(payload.sub, req.socket);
    const user = await requireSessionUser(payload.sub, payload.tv);
    if (session.revoked) return null;
    return { userId: user.id, session };
  } catch {
    if (!session?.revoked) session?.dispose();
    // Malformed cookie escapes, invalid JWTs and unavailable storage all fail closed.
    return null;
  }
}

/** Refuse once: a revocation may already have ended the pending handshake. */
export function rejectUpgrade(socket: Duplex, status: number, statusText: string): void {
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  } catch {
    // ignore
  }
  socket.destroy();
}

/** Accept an owned-resource refusal so browsers can read its close code.
 * Origin, authentication and ownership must already have passed. */
export function closeRefused(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  session: UpgradeSession,
  code: number,
): void {
  if (session.revoked || socket.destroyed || socket.writableEnded) return;
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Install transport errors and revocation handling without starting session work.
    if (session.accept(ws)) ws.close(code);
    else ws.terminate();
  });
}
