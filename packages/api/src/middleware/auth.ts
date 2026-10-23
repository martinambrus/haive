import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context.js';
import { HttpError } from '../context.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { getAccessCookie } from '../auth/cookies.js';
import { getDb } from '../db.js';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';

function authenticate(allowPasswordChange: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getAccessCookie(c);
    if (!token) throw new HttpError(401, 'Not authenticated');

    let payload;
    try {
      payload = await verifyAccessToken(token);
    } catch {
      throw new HttpError(401, 'Invalid or expired token');
    }

    const db = getDb();
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, payload.sub),
      columns: { id: true, role: true, status: true, tokenVersion: true, mustChangePassword: true },
    });
    if (!user || user.status !== 'active') {
      throw new HttpError(401, 'User not found or deactivated');
    }
    if (user.tokenVersion !== payload.tv) {
      throw new HttpError(401, 'Token revoked');
    }
    if (user.mustChangePassword && !allowPasswordChange) {
      throw new HttpError(403, 'Choose a new password to continue', 'must_change_password');
    }

    c.set('userId', user.id);
    c.set('userRole', user.role);
    await next();
  };
}

export const requireAuth = authenticate(false);

/** Only for the routes a user who must replace their password still needs. */
export const requireAuthAllowingPasswordChange = authenticate(true);

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('userRole') !== 'admin') {
    throw new HttpError(403, 'Admin access required');
  }
  await next();
};
