import type { IncomingMessage } from 'node:http';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getDb } from '../db.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { ACCESS_COOKIE } from '../auth/cookies.js';

/** Session policy for every WebSocket surface. Ownership and origin stay with the caller. */
export async function authenticateUpgrade(
  req: IncomingMessage,
): Promise<{ userId: string } | null> {
  try {
    const token = accessCookie(req.headers.cookie);
    if (!token) return null;
    const payload = await verifyAccessToken(token);
    const user = await getDb().query.users.findFirst({
      where: eq(schema.users.id, payload.sub),
      columns: { id: true, status: true, tokenVersion: true, mustChangePassword: true },
    });
    if (
      !user ||
      user.status !== 'active' ||
      user.tokenVersion !== payload.tv ||
      user.mustChangePassword
    ) {
      return null;
    }
    return { userId: user.id };
  } catch {
    // Malformed cookie escapes, invalid JWTs and unavailable storage all fail closed.
    return null;
  }
}

function accessCookie(header: string | undefined): string | null {
  for (const pair of header?.split(';') ?? []) {
    const part = pair.trim();
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq) === ACCESS_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}
