import { describe, expect, it } from 'vitest';
import { decideRouteAccess, type RouteRequest } from './route-access';

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    path: '/dashboard',
    hasAccessCookie: false,
    hasRefreshCookie: false,
    sessionRejected: false,
    ...over,
  };
}

describe('the redirect loop this exists to prevent', () => {
  // A cookie that EXISTS but no longer authenticates satisfies both redirects at once: the
  // middleware sends /login to /dashboard, and the app layout sends /dashboard back to /login.
  // `reset_password` bumps tokenVersion, so an admin could put a user in this state.
  it('renders the login form, and clears the cookies, once the layout says the session is dead', () => {
    const d = decideRouteAccess(
      req({ path: '/login', hasAccessCookie: true, hasRefreshCookie: true, sessionRejected: true }),
    );
    expect(d).toEqual({ action: 'continue-and-clear' });
  });

  // The marker must be checked BEFORE the has-cookie branch, or that branch bounces the visitor
  // back to /dashboard — which is where they just came from.
  it('the marker outranks the has-cookie redirect', () => {
    for (const path of ['/login', '/register', '/setup']) {
      const d = decideRouteAccess(req({ path, hasAccessCookie: true, sessionRejected: true }));
      expect(d, path).toEqual({ action: 'continue-and-clear' });
    }
  });

  // Clearing must not become the normal path: an ordinary visitor to /login keeps their cookies.
  it('does not clear cookies without the marker', () => {
    expect(decideRouteAccess(req({ path: '/login', hasAccessCookie: true }))).toEqual({
      action: 'redirect',
      to: '/dashboard',
    });
  });
});

describe('ordinary routing is unchanged', () => {
  it('sends a signed-in visitor away from the login form', () => {
    expect(decideRouteAccess(req({ path: '/login', hasAccessCookie: true }))).toEqual({
      action: 'redirect',
      to: '/dashboard',
    });
  });

  it('lets a signed-out visitor reach the public pages', () => {
    for (const path of ['/login', '/register', '/setup']) {
      expect(decideRouteAccess(req({ path })), path).toEqual({ action: 'continue' });
    }
  });

  it('sends a signed-out visitor to the login form', () => {
    expect(decideRouteAccess(req({ path: '/dashboard' }))).toEqual({
      action: 'redirect',
      to: '/login',
    });
  });

  // Either token is enough to try — the access token may be expired and refreshable, which is the
  // common case on a returning visit.
  it('lets a refresh-only visitor through to be refreshed', () => {
    expect(decideRouteAccess(req({ path: '/dashboard', hasRefreshCookie: true }))).toEqual({
      action: 'continue',
    });
    expect(decideRouteAccess(req({ path: '/tasks', hasAccessCookie: true }))).toEqual({
      action: 'continue',
    });
  });

  // `/setup` must stay public: an install with no users has nobody who could authenticate for it,
  // so gating it would bounce the visitor to /login, whose form sends them straight back.
  it('keeps /setup public', () => {
    expect(decideRouteAccess(req({ path: '/setup' }))).toEqual({ action: 'continue' });
  });
});
