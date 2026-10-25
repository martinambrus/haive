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
    if (!pair || pair.includes(';')) continue;
    if (eq === -1) {
      kept.push(pair);
      continue;
    }
    const name = pair.slice(0, pair.indexOf('=')).trim();
    // Session readers accept different grammars. Remove their union by name,
    // while keeping non-session data (including off-grammar values) verbatim.
    if (name && !SESSION_COOKIES.has(name)) kept.push(pair);
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

/** HTTP and upgrades share Hono's cookie spelling and first-value rules. */
export function accessCookieFromHeader(header: string | undefined): string | undefined {
  const token = parse(header ?? '', ACCESS_COOKIE)[ACCESS_COOKIE];
  // Hono preserves malformed escapes. Refuse them without letting URIError escape the auth gate.
  try {
    if (token) decodeURIComponent(token);
    return token;
  } catch {
    return undefined;
  }
}

export function getAccessCookie(c: Context): string | undefined {
  return accessCookieFromHeader(c.req.header('Cookie'));
}

export function getRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}
