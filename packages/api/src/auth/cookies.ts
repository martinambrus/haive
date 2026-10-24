import type { Context } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { parse } from 'hono/utils/cookie';
import { ACCESS_TTL, REFRESH_TTL } from './jwt.js';

export const ACCESS_COOKIE = 'haive_access';
export const REFRESH_COOKIE = 'haive_refresh';

const SESSION_COOKIES = new Set([ACCESS_COOKIE, REFRESH_COOKIE]);

export function withoutSessionCookies(header: string): string | null {
  const kept: string[] = [];
  let start = 0;
  while (start < header.length) {
    let end = header.indexOf(';', start);
    if (end === -1) end = header.length;
    const first = header.slice(start, end);
    const eq = first.indexOf('=');
    if (
      eq !== -1 &&
      first
        .slice(eq + 1)
        .trimStart()
        .startsWith('"')
    ) {
      const opener = start + eq + 1 + first.slice(eq + 1).indexOf('"');
      const closer = header.indexOf('"', opener + 1);
      // RFC 6265 cookie-octet excludes semicolons, even in quoted values.
      // Consume the whole malformed quoted pair, rather than promoting its
      // contents into independent pairs. An unterminated quote consumes the rest.
      if (closer === -1) break;
      end = header.indexOf(';', closer + 1);
      if (end === -1) end = header.length;
    }
    const pair = header.slice(start, end).trim();
    start = end + 1;
    if (eq === -1 || pair.includes(';')) continue;
    const name = pair.slice(0, pair.indexOf('=')).trim();
    // Use the same accepted name/value syntax as authentication, but retain the
    // original pair: parsing and serializing would decode values or lose duplicates.
    if (!SESSION_COOKIES.has(name) && Object.hasOwn(parse(pair), name)) kept.push(pair);
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

export function isSessionSetCookie(setCookieValue: string): boolean {
  const eq = setCookieValue.indexOf('=');
  return SESSION_COOKIES.has((eq === -1 ? setCookieValue : setCookieValue.slice(0, eq)).trim());
}

export function withoutSessionSetCookies(upstream: Headers): void {
  const kept = upstream.getSetCookie().filter((line) => !isSessionSetCookie(line));
  upstream.delete('set-cookie');
  for (const line of kept) upstream.append('set-cookie', line);
}

const isProd = process.env.NODE_ENV === 'production';

const baseOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'Lax' as const,
  path: '/',
};

export function setAuthCookies(c: Context, accessToken: string, refreshToken: string): void {
  setCookie(c, ACCESS_COOKIE, accessToken, { ...baseOptions, maxAge: ACCESS_TTL });
  setCookie(c, REFRESH_COOKIE, refreshToken, { ...baseOptions, maxAge: REFRESH_TTL });
}

export function clearAuthCookies(c: Context): void {
  deleteCookie(c, ACCESS_COOKIE, baseOptions);
  deleteCookie(c, REFRESH_COOKIE, baseOptions);
}

export function getAccessCookie(c: Context): string | undefined {
  return getCookie(c, ACCESS_COOKIE);
}

export function getRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}
