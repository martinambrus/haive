import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { secretsService } from '@haive/shared';

export interface AccessTokenPayload {
  sub: string;
  role: 'admin' | 'user';
  tv: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  tv: number;
}

function parseTtl(envValue: string | undefined, fallbackSeconds: number): number {
  if (!envValue) return fallbackSeconds;
  const m = envValue.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!m) return fallbackSeconds;
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    default:
      return fallbackSeconds;
  }
}

const ACCESS_TTL_SECONDS = parseTtl(process.env.JWT_ACCESS_TTL, 24 * 3600); // default: 1 day
const REFRESH_TTL_SECONDS = parseTtl(process.env.JWT_REFRESH_TTL, 30 * 86400); // default: 30 days

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  const secret = await secretsService.getJwtSecret();
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TTL_SECONDS, algorithm: 'HS256' });
}

export async function signRefreshToken(
  userId: string,
  tokenVersion: number,
): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const secret = await secretsService.getJwtSecret();
  const jti = randomBytes(32).toString('hex');
  const payload: RefreshTokenPayload = { sub: userId, jti, tv: tokenVersion };
  const token = jwt.sign(payload, secret, {
    expiresIn: REFRESH_TTL_SECONDS,
    algorithm: 'HS256',
  });
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  return { token, jti, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const secret = await secretsService.getJwtSecret();
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as AccessTokenPayload;
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const secret = await secretsService.getJwtSecret();
  return jwt.verify(token, secret, { algorithms: ['HS256'] }) as RefreshTokenPayload;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const ACCESS_TTL = ACCESS_TTL_SECONDS;
export const REFRESH_TTL = REFRESH_TTL_SECONDS;
