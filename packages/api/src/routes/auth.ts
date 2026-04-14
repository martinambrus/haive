import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  loginRequestSchema,
  registerRequestSchema,
  computeEmailBlindIndex,
  encryptEmail,
  decryptEmail,
  configService,
  secretsService,
} from '@haive/shared';
import { getDb } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '../auth/jwt.js';
import { setAuthCookies, clearAuthCookies, getRefreshCookie } from '../auth/cookies.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

export const authRoutes = new Hono<AppEnv>();

async function issueTokens(
  userId: string,
  role: 'admin' | 'user',
  tokenVersion: number,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const accessToken = await signAccessToken({ sub: userId, role, tv: tokenVersion });
  const { token: refreshToken, expiresAt } = await signRefreshToken(userId, tokenVersion);
  return { accessToken, refreshToken, expiresAt };
}

authRoutes.post('/register', async (c) => {
  const body = registerRequestSchema.parse(await c.req.json());
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const pepper = await secretsService.getEmailBlindIndexPepper();
  const blindIndex = computeEmailBlindIndex(body.email, pepper);

  const existing = await db.query.users.findFirst({
    where: eq(schema.users.emailBlindIndex, blindIndex),
    columns: { id: true },
  });
  if (existing) throw new HttpError(409, 'Email already registered');

  const passwordHash = await hashPassword(body.password);
  const emailEncrypted = encryptEmail(body.email, fieldKey);

  const inserted = await db
    .insert(schema.users)
    .values({ emailEncrypted, emailBlindIndex: blindIndex, passwordHash })
    .returning({
      id: schema.users.id,
      role: schema.users.role,
      status: schema.users.status,
      tokenVersion: schema.users.tokenVersion,
      createdAt: schema.users.createdAt,
    });

  const user = inserted[0]!;
  const { accessToken, refreshToken, expiresAt } = await issueTokens(
    user.id,
    user.role,
    user.tokenVersion,
  );
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });
  setAuthCookies(c, accessToken, refreshToken);

  return c.json(
    {
      user: {
        id: user.id,
        email: body.email,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
      },
    },
    201,
  );
});

authRoutes.post('/login', async (c) => {
  const body = loginRequestSchema.parse(await c.req.json());
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const pepper = await secretsService.getEmailBlindIndexPepper();
  const blindIndex = computeEmailBlindIndex(body.email, pepper);

  const user = await db.query.users.findFirst({
    where: eq(schema.users.emailBlindIndex, blindIndex),
  });
  if (!user || user.status !== 'active') {
    throw new HttpError(401, 'Invalid credentials');
  }

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Invalid credentials');

  const { accessToken, refreshToken, expiresAt } = await issueTokens(
    user.id,
    user.role,
    user.tokenVersion,
  );
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });
  setAuthCookies(c, accessToken, refreshToken);

  return c.json({
    user: {
      id: user.id,
      email: decryptEmail(user.emailEncrypted, fieldKey),
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    },
  });
});

authRoutes.post('/refresh', async (c) => {
  const token = getRefreshCookie(c);
  if (!token) throw new HttpError(401, 'No refresh token');

  let payload;
  try {
    payload = await verifyRefreshToken(token);
  } catch {
    throw new HttpError(401, 'Invalid refresh token');
  }

  const db = getDb();
  const tokenHash = hashRefreshToken(token);
  const row = await db.query.refreshTokens.findFirst({
    where: and(
      eq(schema.refreshTokens.tokenHash, tokenHash),
      eq(schema.refreshTokens.userId, payload.sub),
    ),
  });
  if (!row || row.revokedAt || row.expiresAt < new Date()) {
    throw new HttpError(401, 'Refresh token invalid or expired');
  }

  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, payload.sub),
    columns: { id: true, role: true, status: true, tokenVersion: true },
  });
  if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
    throw new HttpError(401, 'User not found or token revoked');
  }

  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.refreshTokens.id, row.id));

  const {
    accessToken,
    refreshToken: newRefresh,
    expiresAt,
  } = await issueTokens(user.id, user.role, user.tokenVersion);
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(newRefresh),
    expiresAt,
  });
  setAuthCookies(c, accessToken, newRefresh);

  return c.json({ ok: true });
});

authRoutes.post('/logout', requireAuth, async (c) => {
  const token = getRefreshCookie(c);
  const db = getDb();
  if (token) {
    const tokenHash = hashRefreshToken(token);
    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.refreshTokens.tokenHash, tokenHash));
  }
  clearAuthCookies(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
  });
  if (!user) throw new HttpError(404, 'User not found');
  return c.json({
    user: {
      id: user.id,
      email: decryptEmail(user.emailEncrypted, fieldKey),
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    },
  });
});
