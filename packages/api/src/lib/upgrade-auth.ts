import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getDb } from '../db.js';
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
    const user = await getDb().query.users.findFirst({
      where: eq(schema.users.id, payload.sub),
      columns: { id: true, status: true, tokenVersion: true, mustChangePassword: true },
    });
    if (
      session.revoked ||
      !user ||
      user.status !== 'active' ||
      user.tokenVersion !== payload.tv ||
      user.mustChangePassword
    ) {
      if (!session.revoked) session.dispose();
      return null;
    }
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
