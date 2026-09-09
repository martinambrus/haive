import { NextResponse, type NextRequest } from 'next/server';
import {
  decideRouteAccess,
  SESSION_EXPIRED_PARAM,
  SESSION_EXPIRED_VALUE,
} from '@/lib/route-access';

const ACCESS_COOKIE = 'haive_access';
const REFRESH_COOKIE = 'haive_refresh';

export function middleware(request: NextRequest) {
  const decision = decideRouteAccess({
    path: request.nextUrl.pathname,
    hasAccessCookie: request.cookies.has(ACCESS_COOKIE),
    hasRefreshCookie: request.cookies.has(REFRESH_COOKIE),
    sessionRejected:
      request.nextUrl.searchParams.get(SESSION_EXPIRED_PARAM) === SESSION_EXPIRED_VALUE,
  });

  if (decision.action === 'redirect') {
    return NextResponse.redirect(new URL(decision.to, request.url));
  }

  const response = NextResponse.next();
  if (decision.action === 'continue-and-clear') {
    // Deleted HERE rather than by the layout that discovered the problem: a Server Component
    // cannot set cookies, and leaving them in place is what closes the loop — the next request
    // would arrive holding the same dead cookie and be bounced to /dashboard again.
    response.cookies.delete(ACCESS_COOKIE);
    response.cookies.delete(REFRESH_COOKIE);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|.*\\..*).*)'],
};
