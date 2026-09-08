import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  locksOutNonAdmins,
  parseMaintenanceState,
  type MaintenanceState,
} from '@haive/shared';
import { verifyAccessToken } from '../auth/jwt.js';
import { getAccessCookie } from '../auth/cookies.js';
import { getDb } from '../db.js';
import type { AppEnv } from '../context.js';

/**
 * Paths that stay reachable in every state, and each one is load-bearing:
 *
 * - `/health`, `/version` — an upgrade reads `/version` to verify the containers it just swapped
 *   in. Gating it would make the check unanswerable during exactly the window it exists for.
 * - `/auth/*` — an admin has to be able to log in to lift maintenance. Locking the door with the
 *   key inside is the one failure this list prevents.
 * - `/system/*` — read-only system state, which is how the web app learns to render the
 *   maintenance page rather than a wall of failed requests.
 */
const ALWAYS_OPEN = [/^\/health$/, /^\/version(\/|$)/, /^\/auth(\/|$)/, /^\/system(\/|$)/];

/** Resolve the caller's role WITHOUT throwing.
 *
 *  Deliberately not `requireAuth`: this middleware runs before it and must not turn a would-be
 *  401 into a 503, nor a 503 into a 401. An unauthenticated caller is simply "not an admin". */
async function isAdmin(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<boolean> {
  try {
    const token = getAccessCookie(c);
    if (!token) return false;
    const payload = await verifyAccessToken(token);
    const user = await getDb().query.users.findFirst({
      where: eq(schema.users.id, payload.sub),
      columns: { role: true, status: true },
    });
    return user?.status === 'active' && user.role === 'admin';
  } catch {
    return false;
  }
}

/**
 * Hold non-admins out while the system is in maintenance.
 *
 * Mounted once, globally, rather than composed into each of the ~25 routers — a gate that has to
 * be remembered at every mount point is a gate that will be missed at one.
 *
 * The normal state costs ONE cached config read and no database work: the role lookup only
 * happens once the system is actually in maintenance, so this is not a per-request auth
 * duplication in the case that matters.
 *
 * A 503 carries the state in its body, which is what lets the web app render a maintenance page
 * instead of a screenful of failed requests. `Retry-After` is deliberately omitted: a maintenance
 * window has no honest duration to advertise, and a wrong one is worse than none.
 */
export const maintenanceGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const state: MaintenanceState = parseMaintenanceState(
    await configService.get(CONFIG_KEYS.MAINTENANCE_STATE),
  );
  c.set('maintenanceState', state);

  if (!locksOutNonAdmins(state)) return next();
  if (ALWAYS_OPEN.some((p) => p.test(c.req.path))) return next();
  if (await isAdmin(c)) return next();

  return c.json(
    {
      error: 'Haive is in maintenance',
      maintenance: state,
      message: 'The system is being upgraded. It will be available again shortly.',
    },
    503,
  );
};
