import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  accountUpdateSchema,
  gitIdentityUpdateSchema,
  notificationSettingsUpdateSchema,
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

/** Notification sounds are short clips — cap well below the archive upload
 *  limit (MAX_UPLOAD_BYTES in repos.ts is 2 GiB; deliberately not reused). */
const MAX_SOUND_BYTES = 2 * 1024 * 1024;

// Same uploads volume as repo archives and db dumps. repos.ts and db-dumps.ts
// each keep their own local copy of this helper — house style, no shared constant.
function repoStorageRoot(): string {
  return process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
}

const SOUND_EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

const SOUND_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

/** Resolve the canonical {ext, mime} for an uploaded notification sound.
 *  The declared MIME type wins; the filename extension is the fallback for
 *  browsers that send application/octet-stream (or nothing). Returns null
 *  when neither identifies an accepted audio type. Exported for tests. */
export function resolveSoundType(
  filename: string,
  mime: string,
): { ext: string; mime: string } | null {
  const normalizedMime = mime.toLowerCase().split(';')[0]!.trim();
  const extFromMime = SOUND_EXT_BY_MIME[normalizedMime];
  if (extFromMime) return { ext: extFromMime, mime: normalizedMime };
  const extFromName = path.extname(filename).toLowerCase().replace(/^\./, '');
  const mimeFromExt = SOUND_MIME_BY_EXT[extFromName];
  if (mimeFromExt) return { ext: extFromName, mime: mimeFromExt };
  return null;
}

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

userSettingsRoutes.get('/notifications', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const row = await db.query.userNotificationSettings.findFirst({
    where: eq(schema.userNotificationSettings.userId, userId),
  });
  return c.json({
    soundEnabled: row?.soundEnabled ?? true,
    hasCustomSound: Boolean(row?.soundPath),
    soundFilename: row?.soundFilename ?? null,
  });
});

userSettingsRoutes.put('/notifications', async (c) => {
  const userId = c.get('userId');
  const body = notificationSettingsUpdateSchema.parse(await c.req.json());
  const db = getDb();
  await db
    .insert(schema.userNotificationSettings)
    .values({ userId, soundEnabled: body.soundEnabled })
    .onConflictDoUpdate({
      target: schema.userNotificationSettings.userId,
      set: { soundEnabled: body.soundEnabled, updatedAt: new Date() },
    });
  return c.json({ ok: true });
});

userSettingsRoutes.post('/notifications/sound', async (c) => {
  const userId = c.get('userId');
  const db = getDb();

  const form = await c.req.formData();
  const soundField = form.get('sound');
  if (!(soundField instanceof File)) throw new HttpError(400, 'sound file is required');
  if (soundField.size === 0) throw new HttpError(400, 'sound file is empty');
  if (soundField.size > MAX_SOUND_BYTES) {
    throw new HttpError(413, `sound exceeds ${MAX_SOUND_BYTES} bytes limit`);
  }
  const resolved = resolveSoundType(soundField.name, soundField.type);
  if (!resolved) {
    throw new HttpError(
      400,
      'unsupported audio type (allowed: mp3, wav, ogg, webm, m4a, aac, flac)',
    );
  }

  const existing = await db.query.userNotificationSettings.findFirst({
    where: eq(schema.userNotificationSettings.userId, userId),
    columns: { soundPath: true },
  });

  const uploadDir = path.join(repoStorageRoot(), '_uploads', userId);
  await mkdir(uploadDir, { recursive: true });
  const soundPath = path.join(uploadDir, `notification-sound.${resolved.ext}`);

  try {
    const body = soundField.stream() as unknown as ReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(body as never), createWriteStream(soundPath));
  } catch (err) {
    await rm(soundPath, { force: true }).catch(() => {});
    throw new HttpError(500, `failed to write sound: ${(err as Error).message}`);
  }

  // Replacing e.g. an .mp3 with a .wav leaves the old file behind — remove it.
  if (existing?.soundPath && existing.soundPath !== soundPath) {
    await rm(existing.soundPath, { force: true }).catch(() => {});
  }

  const soundFilename = soundField.name.slice(0, 255);
  await db
    .insert(schema.userNotificationSettings)
    .values({ userId, soundPath, soundMime: resolved.mime, soundFilename })
    .onConflictDoUpdate({
      target: schema.userNotificationSettings.userId,
      set: { soundPath, soundMime: resolved.mime, soundFilename, updatedAt: new Date() },
    });

  const row = await db.query.userNotificationSettings.findFirst({
    where: eq(schema.userNotificationSettings.userId, userId),
    columns: { soundEnabled: true },
  });
  return c.json(
    { soundEnabled: row?.soundEnabled ?? true, hasCustomSound: true, soundFilename },
    201,
  );
});

userSettingsRoutes.delete('/notifications/sound', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const row = await db.query.userNotificationSettings.findFirst({
    where: eq(schema.userNotificationSettings.userId, userId),
    columns: { soundPath: true },
  });
  if (row?.soundPath) await rm(row.soundPath, { force: true }).catch(() => {});
  await db
    .update(schema.userNotificationSettings)
    .set({ soundPath: null, soundMime: null, soundFilename: null, updatedAt: new Date() })
    .where(eq(schema.userNotificationSettings.userId, userId));
  return c.json({ ok: true });
});

userSettingsRoutes.get('/notifications/sound', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const row = await db.query.userNotificationSettings.findFirst({
    where: eq(schema.userNotificationSettings.userId, userId),
    columns: { soundPath: true, soundMime: true },
  });
  if (!row?.soundPath) throw new HttpError(404, 'No custom notification sound');
  let st;
  try {
    st = await stat(row.soundPath);
  } catch {
    throw new HttpError(404, 'Sound file missing on disk');
  }
  c.header('Content-Type', row.soundMime ?? 'application/octet-stream');
  c.header('Content-Length', String(st.size));
  c.header('Cache-Control', 'no-store');
  return c.body(Readable.toWeb(createReadStream(row.soundPath)) as ReadableStream);
});
