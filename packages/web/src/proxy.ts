import { NextResponse, type NextRequest } from 'next/server';
import {
  decideRouteAccess,
  SESSION_EXPIRED_PARAM,
  SESSION_EXPIRED_VALUE,
  PUBLIC_PATHS,
} from '@/lib/route-access';
import { resolveApiOrigin, runtimeApiConfig } from '@/lib/api-origin';
import { browserHostname, contentSecurityPolicy } from '@/lib/content-security-policy';

const ACCESS_COOKIE = 'haive_access';
const REFRESH_COOKIE = 'haive_refresh';

export async function proxy(request: NextRequest) {
  const sessionRejected =
    request.nextUrl.searchParams.get(SESSION_EXPIRED_PARAM) === SESSION_EXPIRED_VALUE;
  let sessionAuthenticated = false;
  if (
    PUBLIC_PATHS.has(request.nextUrl.pathname) &&
    request.cookies.has(ACCESS_COOKIE) &&
    !sessionRejected
  ) {
    // Public onward navigation cannot trust retained cookies. A stale cookie must still allow
    // setup, registration and invitations; a live session keeps the ordinary dashboard redirect.
    // This probe is read-only: rotation stays in the browser, where cookies can be installed.
    try {
      const apiBase =
        process.env.API_URL_INTERNAL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
      const result = await fetch(`${apiBase}/auth/me`, {
        headers: { Cookie: request.headers.get('cookie') ?? '' },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      sessionAuthenticated = result.ok;
    } catch {
      // Uncertain authentication never blocks a public page or clears a shared cookie jar.
    }
  }
  const decision = decideRouteAccess({
    path: request.nextUrl.pathname,
    hasAccessCookie: request.cookies.has(ACCESS_COOKIE),
    hasRefreshCookie: request.cookies.has(REFRESH_COOKIE),
    sessionRejected,
    sessionAuthenticated,
  });

  if (decision.action === 'redirect') {
    return NextResponse.redirect(new URL(decision.to, request.url));
  }

  const response = NextResponse.next();
  // Per request, because the api origin is the browser's own hostname on a port set at runtime.
  const apiOrigin = resolveApiOrigin({
    config: runtimeApiConfig(),
    location: {
      protocol: request.nextUrl.protocol,
      hostname: browserHostname(request.headers.get('host'), request.nextUrl.hostname),
    },
    buildTime: process.env.NEXT_PUBLIC_API_URL,
  });
  response.headers.set('Content-Security-Policy', contentSecurityPolicy(apiOrigin));
  return response;
}

export const config = {
  matcher: [
    '/((?!_next|favicon.ico|.*\\..*).*)',
    // A module provider id holds dots, which the entry above takes for a static file.
    '/settings/integrations/callback/:providerId',
  ],
};
