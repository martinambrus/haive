import { NextResponse, type NextRequest } from 'next/server';
import {
  decideRouteAccess,
  SESSION_EXPIRED_PARAM,
  SESSION_EXPIRED_VALUE,
} from '@/lib/route-access';
import { resolveApiOrigin, runtimeApiConfig } from '@/lib/api-origin';
import { browserHostname, contentSecurityPolicy } from '@/lib/content-security-policy';

const ACCESS_COOKIE = 'haive_access';
const REFRESH_COOKIE = 'haive_refresh';

export function proxy(request: NextRequest) {
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
