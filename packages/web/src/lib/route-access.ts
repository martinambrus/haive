/** Cookie presence is only a routing hint. A rejected-session marker allows the login form
 * to render without looping, but never deletes shared cookies: a delayed navigation may carry
 * that marker after a different tab has successfully rotated the session. */

/** Pages reachable without a session. `/setup` is here because an install with no users has nobody
 *  who could authenticate for it. */
export const PUBLIC_PATHS = new Set(['/login', '/register', '/setup']);

/** Marker browser recovery adds after the current session is refused. */
export const SESSION_EXPIRED_PARAM = 'session';
export const SESSION_EXPIRED_VALUE = 'expired';

export interface RouteRequest {
  path: string;
  hasAccessCookie: boolean;
  hasRefreshCookie: boolean;
  /** `?session=expired` — allow the login form even if cookies still exist. */
  sessionRejected: boolean;
}

export type RouteDecision = { action: 'continue' } | { action: 'redirect'; to: string };

export function decideRouteAccess(req: RouteRequest): RouteDecision {
  if (PUBLIC_PATHS.has(req.path)) {
    // Recovery must be able to show login despite dead cookies. Their presence alone would
    // bounce back to the protected page, which would ask for recovery again.
    if (req.sessionRejected) return { action: 'continue' };
    // A visitor who is genuinely signed in has no use for the login form.
    if (req.hasAccessCookie) return { action: 'redirect', to: '/dashboard' };
    return { action: 'continue' };
  }

  // Either token is enough to try: the client-side interceptor refreshes an expired access token,
  // and a failed server read renders browser recovery.
  if (!req.hasAccessCookie && !req.hasRefreshCookie) return { action: 'redirect', to: '/login' };
  return { action: 'continue' };
}

/** How long a dead-session reload refuses the next one, so a page the server keeps rendering while
 *  the api refuses it cannot reload in a loop. */
export const SESSION_RELOAD_COOLDOWN_MS = 30_000;

export interface SessionEndRequest {
  path: string;
  /** When this tab last reloaded for a dead session, if it has. */
  lastReloadAt: number | null;
  now: number;
}

/** `reload` hands the verdict to the layout's server-side check, `hold` stops asking without
 *  reloading again, `none` leaves a public page alone — no session is expected there. */
export type SessionEndAction = 'none' | 'reload' | 'hold';

export function decideSessionEnd(req: SessionEndRequest): SessionEndAction {
  if (PUBLIC_PATHS.has(req.path)) return 'none';
  if (req.lastReloadAt !== null && req.now - req.lastReloadAt < SESSION_RELOAD_COOLDOWN_MS) {
    return 'hold';
  }
  return 'reload';
}

/** Everything under the admin console. */
export const ADMIN_PATH = '/admin';

export interface AdminAccessRequest {
  /** From `usePathname()`, nullable for the same reason as below. */
  path: string | null;
  role: 'admin' | 'user';
}

/**
 * Send a non-admin who reached an admin URL back to their dashboard.
 *
 * UX only, and deliberately so — `requireAdmin` on the api is the authorisation boundary and stays
 * the thing that actually refuses. Without this the page shell rendered, every `/admin/*` read
 * failed, and the result was an admin console showing "Admin access required" instead of a visitor
 * simply not being there. That is a worse answer than a redirect, not a safer one.
 *
 * Like `decideForcedPasswordChange`, this is the redirect over an api that also refuses: the role
 * this reads comes from the same `/auth/me` session the api authorises against — so the two cannot
 * disagree about who is an administrator.
 *
 * Fails OPEN on an unknown path, like its neighbour: redirecting a route we cannot identify is how
 * a guard sends someone away from the page it was meant to protect.
 */
export function decideAdminAccess(req: AdminAccessRequest): RouteDecision {
  if (req.role === 'admin') return { action: 'continue' };
  if (!req.path) return { action: 'continue' };
  if (req.path === ADMIN_PATH || req.path.startsWith(`${ADMIN_PATH}/`)) {
    return { action: 'redirect', to: '/dashboard' };
  }
  return { action: 'continue' };
}

/** The one page a visitor who must replace their password is allowed to be on. */
export const PASSWORD_CHANGE_PATH = '/settings/account';

export interface ForcedPasswordRequest {
  /** From `usePathname()`. Nullable so an unknown path is a case this function must answer — see
   *  the fail-open branch below. */
  path: string | null;
  mustChangePassword: boolean;
}

/**
 * A user carrying a password an administrator minted for them is sent to change it.
 *
 * The flag is set wherever such a password is created and cleared only by the holder changing it.
 * The redirect is the UX; the api is the boundary — `requireAuth` answers 403 `must_change_password`
 * to every request but `/auth/me`, the password change, logout and refresh while the flag is set.
 *
 * Applied on the CLIENT, by `ForcedPasswordGuard`, because a Server Component cannot learn which
 * route it is rendering. Forwarding the path from middleware as a request header was tried and
 * MEASURED to break RSC navigation outright: `NextResponse.next({ request: { headers } })` made a
 * single visit to /settings/account re-request `?_rsc=` about a thousand times in 40 seconds and
 * render a blank page, while the same visit without it is one request.
 */
export function decideForcedPasswordChange(req: ForcedPasswordRequest): RouteDecision {
  if (!req.mustChangePassword) return { action: 'continue' };
  // An unrecognised path CONTINUES — the same loop this file's header describes, seen from the
  // other side. Redirecting a path we cannot identify would redirect the password page itself.
  if (!req.path) return { action: 'continue' };
  if (req.path === PASSWORD_CHANGE_PATH || req.path.startsWith(`${PASSWORD_CHANGE_PATH}/`)) {
    return { action: 'continue' };
  }
  return { action: 'redirect', to: PASSWORD_CHANGE_PATH };
}
