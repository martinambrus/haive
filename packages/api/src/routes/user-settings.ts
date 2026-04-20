import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  accountUpdateSchema,
  gitIdentityUpdateSchema,
  passwordChangeSchema,
  configService,
  encrypt,
  decrypt,
  decryptEmail,
} from '@haive/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signAccessToken, signRefreshToken, hashRefreshToken } from '../auth/jwt.js';
import { setAuthCookies } from '../auth/cookies.js';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';

export const userSettingsRoutes = new Hono<AppEnv>();

userSettingsRoutes.use('*', requireAuth);

userSettingsRoutes.get('/account', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { name: true, phoneEncrypted: true, emailEncrypted: true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  return c.json({
    name: user.name,
    phone: user.phoneEncrypted ? decrypt(user.phoneEncrypted, fieldKey) : null,
    email: decryptEmail(user.emailEncrypted, fieldKey),
  });
});

userSettingsRoutes.put('/account', async (c) => {
  const userId = c.get('userId');
  const body = accountUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const update: { name?: string | null; phoneEncrypted?: string | null; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) {
    update.name = body.name.length > 0 ? body.name : null;
  }
  if (body.phone !== undefined) {
    if (body.phone.length > 0) {
      const fieldKey = await configService.getEncryptionKey();
      update.phoneEncrypted = encrypt(body.phone, fieldKey);
    } else {
      update.phoneEncrypted = null;
    }
  }
  await db.update(schema.users).set(update).where(eq(schema.users.id, userId));
  return c.json({ ok: true });
});

userSettingsRoutes.put('/password', async (c) => {
  const userId = c.get('userId');
  const body = passwordChangeSchema.parse(await c.req.json());
  const db = getDb();

  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { id: true, role: true, passwordHash: true, tokenVersion: true },
  });
  if (!user) throw new HttpError(404, 'User not found');

  const ok = await verifyPassword(body.currentPassword, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Current password is incorrect');

  const newHash = await hashPassword(body.newPassword);
  const newTokenVersion = user.tokenVersion + 1;
  await db
    .update(schema.users)
    .set({ passwordHash: newHash, tokenVersion: newTokenVersion, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));

  const accessToken = await signAccessToken({
    sub: user.id,
    role: user.role,
    tv: newTokenVersion,
  });
  const { token: refreshToken, expiresAt } = await signRefreshToken(user.id, newTokenVersion);
  await db.insert(schema.refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt,
  });
  setAuthCookies(c, accessToken, refreshToken);

  return c.json({ ok: true });
});

userSettingsRoutes.get('/git-identity', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { gitName: true, gitEmail: true },
  });
  if (!user) throw new HttpError(404, 'User not found');
  return c.json({ gitName: user.gitName, gitEmail: user.gitEmail });
});

userSettingsRoutes.put('/git-identity', async (c) => {
  const userId = c.get('userId');
  const body = gitIdentityUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const update: { gitName?: string | null; gitEmail?: string | null; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (body.gitName !== undefined) {
    update.gitName = body.gitName.length > 0 ? body.gitName : null;
  }
  if (body.gitEmail !== undefined) {
    update.gitEmail = body.gitEmail.length > 0 ? body.gitEmail : null;
  }
  await db.update(schema.users).set(update).where(eq(schema.users.id, userId));
  return c.json({ ok: true });
});
