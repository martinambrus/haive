import { NextResponse, type NextRequest } from 'next/server';

// `/setup` MUST be here. It is reachable only when the install has no users, so no one can be
// authenticated for it — without it this middleware bounces the visitor to `/login`, whose form
// reads the same registration status and bounces them back to `/setup`, forever.
const PUBLIC_PATHS = new Set(['/login', '/register', '/setup']);

export function middleware(request: NextRequest) {
  const accessCookie = request.cookies.get('haive_access');
  const refreshCookie = request.cookies.get('haive_refresh');
  const path = request.nextUrl.pathname;

  if (PUBLIC_PATHS.has(path)) {
    if (accessCookie) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.next();
  }

  // Allow through if either token exists — client-side interceptor handles refresh
  if (!accessCookie && !refreshCookie) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|.*\\..*).*)'],
};
