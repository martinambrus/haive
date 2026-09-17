import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
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
import { lstatNoFollow, openFileNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { requireAuth } from '../middleware/auth.js';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import { containmentHttpError } from '../lib/fs-http.js';
import { ensureUploadsDir, uploadFileRel, uploadsRel, uploadsStorageRoot } from '../lib/uploads.js';

/** Notification sounds are short clips — cap well below the archive upload
 *  limit (MAX_UPLOAD_BYTES in repos.ts is 2 GiB; deliberately not reused). */
const MAX_SOUND_BYTES = 2 * 1024 * 1024;

/** Remove a sound file a row names, when the row's path is one this api wrote.
 *
 *  A refused shape is skipped rather than fatal: the row is being cleared either way, and a
 *  leftover file is not a reason to fail the request the user made. */
async function removeSoundFile(userId: string, stored: string): Promise<void> {
  const rel = uploadFileRel(userId, stored);
  if (!rel) return;
  await removeNoFollow(uploadsStorageRoot(), rel).catch(() => {});
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
    .set({
      passwordHash: newHash,
      tokenVersion: newTokenVersion,
      // The one writer that clears it: this route is the only place the account HOLDER chooses the
      // password, which is the whole condition the flag records.
      mustChangePassword: false,
      updatedAt: new Date(),
    })
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

const DEFAULT_IDE_SETTINGS_JSON = '{\n  "telemetry.telemetryLevel": "off"\n}';
const MAX_IDE_SETTINGS_BYTES = 64 * 1024;

/** Per-user global code-server settings.json (seeded into every task's IDE at
 *  launch). Returns the built-in default when the user has no row, so the editor
 *  textarea always shows valid JSON. */
userSettingsRoutes.get('/ide', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const row = await db.query.userIdeSettings.findFirst({
    where: eq(schema.userIdeSettings.userId, userId),
    columns: { settingsJson: true },
  });
  return c.json({ settingsJson: row?.settingsJson ?? DEFAULT_IDE_SETTINGS_JSON });
});

userSettingsRoutes.put('/ide', async (c) => {
  const userId = c.get('userId');
  const body = (await c.req.json()) as { settingsJson?: unknown };
  const settingsJson = body.settingsJson;
  if (typeof settingsJson !== 'string') throw new HttpError(400, 'settingsJson must be a string');
  if (Buffer.byteLength(settingsJson, 'utf8') > MAX_IDE_SETTINGS_BYTES) {
    throw new HttpError(413, 'settings exceed the 64 KiB limit');
  }
  try {
    JSON.parse(settingsJson);
  } catch {
    throw new HttpError(400, 'settingsJson must be valid JSON');
  }
  const db = getDb();
  await db
    .insert(schema.userIdeSettings)
    .values({ userId, settingsJson })
    .onConflictDoUpdate({
      target: schema.userIdeSettings.userId,
      set: { settingsJson, updatedAt: new Date() },
    });
  return c.json({ ok: true });
});

// Per-user UI preferences (plan-canvas view + split today). Same contract as
// /ide: one JSON blob, web-owned keys, 64 KiB cap, absent row = '{}'.
userSettingsRoutes.get('/ui-prefs', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const row = await db.query.userUiPrefs.findFirst({
    where: eq(schema.userUiPrefs.userId, userId),
    columns: { settingsJson: true },
  });
  return c.json({ settingsJson: row?.settingsJson ?? '{}' });
});

userSettingsRoutes.put('/ui-prefs', async (c) => {
  const userId = c.get('userId');
  const body = (await c.req.json()) as { settingsJson?: unknown };
  const settingsJson = body.settingsJson;
  if (typeof settingsJson !== 'string') throw new HttpError(400, 'settingsJson must be a string');
  if (Buffer.byteLength(settingsJson, 'utf8') > MAX_IDE_SETTINGS_BYTES) {
    throw new HttpError(413, 'settings exceed the 64 KiB limit');
  }
  try {
    JSON.parse(settingsJson);
  } catch {
    throw new HttpError(400, 'settingsJson must be valid JSON');
  }
  const db = getDb();
  await db
    .insert(schema.userUiPrefs)
    .values({ userId, settingsJson })
    .onConflictDoUpdate({
      target: schema.userUiPrefs.userId,
      set: { settingsJson, updatedAt: new Date() },
    });
  return c.json({ ok: true });
});

/** Merge a partial blob instead of replacing it.
 *
 *  The PUT above is last-write-wins over the WHOLE blob, and its callers each hold a copy
 *  read once at mount. That is fine while one page owns every key, but the sidebar writes
 *  its width from the app shell — present on the plan and statistics pages too — so a
 *  splitter drag there would PUT a blob that predates the resize and silently drop it.
 *  Merging in the upsert means no reader is involved and there is no read-modify-write
 *  window to lose. */
userSettingsRoutes.patch('/ui-prefs', async (c) => {
  const userId = c.get('userId');
  const body = (await c.req.json()) as { settingsJson?: unknown };
  const settingsJson = body.settingsJson;
  if (typeof settingsJson !== 'string') throw new HttpError(400, 'settingsJson must be a string');
  if (Buffer.byteLength(settingsJson, 'utf8') > MAX_IDE_SETTINGS_BYTES) {
    throw new HttpError(413, 'settings exceed the 64 KiB limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    throw new HttpError(400, 'settingsJson must be valid JSON');
  }
  // Not merely a shape check: jsonb `||` CONCATENATES two arrays and REPLACES a scalar,
  // so a non-object patch would destroy the blob rather than merge into it.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'settingsJson must be a JSON object');
  }
  const db = getDb();
  await db
    .insert(schema.userUiPrefs)
    .values({ userId, settingsJson })
    .onConflictDoUpdate({
      target: schema.userUiPrefs.userId,
      // An unqualified column reference in DO UPDATE is the EXISTING row, which is the
      // side being merged into; `excluded` would be the patch we are already binding.
      set: {
        settingsJson: sql`(coalesce(${schema.userUiPrefs.settingsJson}, '{}')::jsonb || ${settingsJson}::jsonb)::text`,
        updatedAt: new Date(),
      },
    });
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
    usageAlertEnabled: row?.usageAlertEnabled ?? true,
    hasCustomSound: Boolean(row?.soundPath),
    soundFilename: row?.soundFilename ?? null,
  });
});

userSettingsRoutes.put('/notifications', async (c) => {
  const userId = c.get('userId');
  const body = notificationSettingsUpdateSchema.parse(await c.req.json());
  const db = getDb();
  // usageAlertEnabled is optional in the schema: a PUT that omits it must leave the
  // stored preference alone rather than resetting it to the column default.
  const usageAlert =
    body.usageAlertEnabled === undefined ? {} : { usageAlertEnabled: body.usageAlertEnabled };
  await db
    .insert(schema.userNotificationSettings)
    .values({ userId, soundEnabled: body.soundEnabled, ...usageAlert })
    .onConflictDoUpdate({
      target: schema.userNotificationSettings.userId,
      set: { soundEnabled: body.soundEnabled, ...usageAlert, updatedAt: new Date() },
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

  const anchor = await ensureUploadsDir(userId);
  const soundRel = `${uploadsRel(userId)}/notification-sound.${resolved.ext}`;
  const soundPath = path.join(anchor, soundRel);

  // The name is FIXED per extension, so unlike every other upload here a re-upload legitimately
  // replaces an existing file — hence replace-atomic rather than create-exclusive. Streamed through
  // the descriptor that mode opens, so the bytes cannot land anywhere but that inode, and a link at
  // the name is refused instead of written through.
  try {
    const body = soundField.stream() as unknown as ReadableStream<Uint8Array>;
    const fh = await openFileNoFollow(anchor, soundRel, 'create-exclusive', {
      fileMode: 0o644,
    }).catch(async (err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await removeNoFollow(anchor, soundRel);
      return openFileNoFollow(anchor, soundRel, 'create-exclusive', { fileMode: 0o644 });
    });
    try {
      await pipeline(Readable.fromWeb(body as never), fh.createWriteStream());
    } finally {
      await fh.close().catch(() => {});
    }
  } catch (err) {
    await removeNoFollow(anchor, soundRel).catch(() => {});
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `failed to write sound: ${(err as Error).message}`);
  }

  // Replacing e.g. an .mp3 with a .wav leaves the old file behind — remove it.
  if (existing?.soundPath && existing.soundPath !== soundPath) {
    await removeSoundFile(userId, existing.soundPath);
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
    columns: { soundEnabled: true, usageAlertEnabled: true },
  });
  return c.json(
    {
      soundEnabled: row?.soundEnabled ?? true,
      usageAlertEnabled: row?.usageAlertEnabled ?? true,
      hasCustomSound: true,
      soundFilename,
    },
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
  if (row?.soundPath) await removeSoundFile(userId, row.soundPath);
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
  const anchor = uploadsStorageRoot();
  const soundRel = uploadFileRel(userId, row.soundPath);
  if (!soundRel) throw new HttpError(404, 'Sound file missing on disk');
  const info = await lstatNoFollow(anchor, soundRel);
  if (!info || info.kind !== 'file') throw new HttpError(404, 'Sound file missing on disk');
  const fh = await openFileNoFollow(anchor, soundRel, 'read', { strict: true }).catch(
    (err: unknown) => containmentHttpError(err, 'Sound path is outside the uploads directory'),
  );
  if (!fh) throw new HttpError(404, 'Sound file missing on disk');
  c.header('Content-Type', row.soundMime ?? 'application/octet-stream');
  c.header('Content-Length', String(info.stats.size));
  c.header('Cache-Control', 'no-store');
  // Streamed from the verified descriptor, and NOT closed here: the stream is the response body, so
  // closing behind Hono would truncate it. MEASURED on node v26.7.0 for PR 8 — such a stream closes
  // its own handle on normal end, on destroy and on `toWeb` cancel, and leaks only when created and
  // then neither read nor destroyed, which a response body never is.
  return c.body(Readable.toWeb(fh.createReadStream()) as ReadableStream);
});
