import { NextResponse, type NextRequest } from 'next/server';
import {
  decideRouteAccess,
  SESSION_EXPIRED_PARAM,
  SESSION_EXPIRED_VALUE,
  PUBLIC_PATHS,
} from '@/lib/route-access';
import { resolveApiOrigin, resolveEditorOrigin, runtimeApiConfig } from '@/lib/api-origin';
import { browserHostname, contentSecurityPolicy } from '@/lib/content-security-policy';
import { apiProxyTarget } from '@/lib/api-proxy.server';
import { resolveServerApiBase } from '@/lib/api-base.server';

const ACCESS_COOKIE = 'haive_access';
const REFRESH_COOKIE = 'haive_refresh';

export async function proxy(request: NextRequest) {
  // Next's existing upgrade handler forwards this rewrite, preserving Origin and Cookie.
  // HTTP uses streaming route handlers so auth refresh has no proxy response deadline.
  try {
    const target = apiProxyTarget(request.url);
    if (target) return NextResponse.rewrite(target);
  } catch {
    return new NextResponse('Invalid server API URL configuration', { status: 502 });
  }

  if (request.nextUrl.pathname !== '/' && request.nextUrl.pathname.endsWith('/')) {
    const canonical = new URL(request.url);
    canonical.pathname = canonical.pathname.replace(/\/+$/, '');
    return NextResponse.redirect(canonical, 308);
  }

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
      const apiBase = resolveServerApiBase();
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
  let browserPort = request.nextUrl.port;
  try {
    browserPort = new URL(`http://${request.headers.get('host') ?? request.nextUrl.host}`).port;
  } catch {
    // Keep the parsed request URL's port if an upstream supplies an invalid Host header.
  }
  // Per request, because the api origin is the browser's own hostname on a port set at runtime.
  const originInputs = {
    config: runtimeApiConfig(),
    location: {
      protocol: request.nextUrl.protocol,
      hostname: browserHostname(request.headers.get('host'), request.nextUrl.hostname),
      port: browserPort,
    },
    buildTime: process.env.NEXT_PUBLIC_API_URL,
  };
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy(resolveApiOrigin(originInputs), resolveEditorOrigin(originInputs)),
  );
  return response;
}

export const config = {
  matcher: [
    '/((?!_next|favicon.ico|api/haive(?:/|$)|.*\\..*).*)',
    {
      source: '/api/haive/:path*',
      has: [{ type: 'header', key: 'upgrade', value: 'websocket' }],
    },
    // A module provider id holds dots, which the entry above takes for a static file.
    '/settings/integrations/callback/:providerId',
  ],
};
