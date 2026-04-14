import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = new Set(['/login', '/register']);

export function middleware(request: NextRequest) {
  const accessCookie = request.cookies.get('haive_access');
  const path = request.nextUrl.pathname;

  if (PUBLIC_PATHS.has(path)) {
    if (accessCookie) {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
    return NextResponse.next();
  }

  if (!accessCookie) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|.*\\..*).*)'],
};
