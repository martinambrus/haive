import type { Context } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { ACCESS_TTL, REFRESH_TTL } from './jwt.js';

export const ACCESS_COOKIE = 'haive_access';
export const REFRESH_COOKIE = 'haive_refresh';

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
