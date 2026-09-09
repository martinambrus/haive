/**
 * What the middleware should do with a request, as a pure decision.
 *
 * Extracted from `middleware.ts` because the interesting case is a LOOP between two files, and a
 * loop is exactly what neither file can be read to rule out on its own:
 *
 *   - the middleware sends a visitor holding an access cookie from `/login` to `/dashboard`
 *   - `(app)/layout.tsx` sends a visitor whose session does not authenticate back to `/login`
 *
 * A cookie that EXISTS but no longer works satisfies both at once, so the browser bounces between
 * them until it gives up with `ERR_TOO_MANY_REDIRECTS`. That is not hypothetical: `reset_password`
 * and `set_role` both bump `tokenVersion`, which invalidates the cookie the browser still holds —
 * so an administrator resetting someone's password could lock them out of the login page.
 *
 * The fix is that the layout, which is the only side that KNOWS the session is dead, says so in
 * the redirect, and the middleware then clears the stale cookies instead of trusting them.
 */

/** Pages reachable without a session. `/setup` is here because an install with no users has nobody
 *  who could authenticate for it. */
export const PUBLIC_PATHS = new Set(['/login', '/register', '/setup']);

/** Marker the app layout adds when it has already asked the api and been refused. */
export const SESSION_EXPIRED_PARAM = 'session';
export const SESSION_EXPIRED_VALUE = 'expired';

export interface RouteRequest {
  path: string;
  hasAccessCookie: boolean;
  hasRefreshCookie: boolean;
  /** `?session=expired` — the layout telling us the cookies it is holding do not work. */
  sessionRejected: boolean;
}

export type RouteDecision =
  | { action: 'continue' }
  /** Render the page AND delete the stale cookies, so the next request is a clean one. */
  | { action: 'continue-and-clear' }
  | { action: 'redirect'; to: string };

export function decideRouteAccess(req: RouteRequest): RouteDecision {
  if (PUBLIC_PATHS.has(req.path)) {
    // Checked BEFORE the has-cookie branch below, which is the whole fix: that branch is what
    // sends the visitor back to `/dashboard`, and `/dashboard` is what sent them here.
    if (req.sessionRejected) return { action: 'continue-and-clear' };
    // A visitor who is genuinely signed in has no use for the login form.
    if (req.hasAccessCookie) return { action: 'redirect', to: '/dashboard' };
    return { action: 'continue' };
  }

  // Either token is enough to try: the client-side interceptor refreshes an expired access token,
  // and the layout falls back to a server-side refresh.
  if (!req.hasAccessCookie && !req.hasRefreshCookie) return { action: 'redirect', to: '/login' };
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
 * The flag is set wherever such a password is created and cleared only by the holder changing it,
 * so this is the whole enforcement — the api gates nothing on it. That is deliberate: it is
 * hygiene, not an authorisation boundary, and a redirect the api also enforced would take a
 * partially-broken deploy from "annoying" to "locked out".
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
