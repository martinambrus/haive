import { describe, expect, it } from 'vitest';
import {
  decideForcedPasswordChange,
  decideRouteAccess,
  PASSWORD_CHANGE_PATH,
  type ForcedPasswordRequest,
  type RouteRequest,
} from './route-access';

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

describe('a password an administrator minted', () => {
  function forced(over: Partial<ForcedPasswordRequest> = {}): ForcedPasswordRequest {
    return { path: '/dashboard', mustChangePassword: true, ...over };
  }

  it('sends its holder to the page where they can replace it', () => {
    expect(decideForcedPasswordChange(forced())).toEqual({
      action: 'redirect',
      to: PASSWORD_CHANGE_PATH,
    });
  });

  // The loop this function's sibling exists to prevent, from the other side: the destination must
  // not redirect to itself.
  it('does not redirect the password page to itself', () => {
    expect(decideForcedPasswordChange(forced({ path: PASSWORD_CHANGE_PATH }))).toEqual({
      action: 'continue',
    });
    expect(
      decideForcedPasswordChange(forced({ path: `${PASSWORD_CHANGE_PATH}/anything` })),
    ).toEqual({ action: 'continue' });
    // A path that merely SHARES the prefix is a different page and is still redirected.
    expect(decideForcedPasswordChange(forced({ path: '/settings/account-recovery' }))).toEqual({
      action: 'redirect',
      to: PASSWORD_CHANGE_PATH,
    });
  });

  // Fails OPEN. An unknown path would otherwise redirect the destination too, which is a lockout
  // over a UX nudge — the api enforces nothing on this flag.
  it('continues when the path is unknown', () => {
    expect(decideForcedPasswordChange(forced({ path: null }))).toEqual({ action: 'continue' });
  });

  it('leaves everyone else alone', () => {
    for (const path of ['/dashboard', '/settings/account', '/admin', null]) {
      expect(decideForcedPasswordChange({ path, mustChangePassword: false }), String(path)).toEqual(
        {
          action: 'continue',
        },
      );
    }
  });
});
