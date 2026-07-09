import { createWriteStream } from 'node:fs';
import { mkdir, open, rm, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { schema } from '@haive/database';
import { initDbUploadRequestSchema, type DbDumpFormat } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

// Shared with the repo upload: same 2 GiB default + storage volume.
function maxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (!raw) return 2 * 1024 * 1024 * 1024; // 2 GiB default
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2 * 1024 * 1024 * 1024;
  return parsed;
}

function repoStorageRoot(): string {
  return process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
}

/** Best-effort DB dump format label by extension. `.sql.gz` is checked before
 *  `.sql`. Unrecognized extensions are NOT rejected — they fall back to `dump`
 *  and the actual `ddev import-db` restore is the real arbiter of whether a dump
 *  loads (PostgreSQL backups in particular carry arbitrary extensions like
 *  `.backup`). This is a display label only; the import auto-detects the format
 *  from the on-disk file (see dumpDiskExtension). */
export function detectDumpFormat(filename: string): DbDumpFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.sql.gz')) return 'sql.gz';
  if (lower.endsWith('.sql')) return 'sql';
  return 'dump';
}

/** On-disk extension for the saved dump, preserving the uploaded file's own
 *  extension so `ddev import-db` can auto-detect compression/archive format. The
 *  result becomes part of a path interpolated into a shell `ddev import-db
 *  --file=…`, so it is restricted to a safe charset; anything outside it (or an
 *  extensionless name) falls back to `dump`. */
export function dumpDiskExtension(filename: string): string {
  const base = path.basename(filename).toLowerCase();
  let ext = 'dump';
  if (base.endsWith('.sql.gz')) {
    ext = 'sql.gz';
  } else {
    const dot = base.lastIndexOf('.');
    if (dot > 0 && dot < base.length - 1) ext = base.slice(dot + 1);
  }
  return /^[a-z0-9.]{1,16}$/.test(ext) ? ext : 'dump';
}

function sessionFromRow(row: typeof schema.dbUploads.$inferSelect) {
  return {
    id: row.id,
    filename: row.filename,
    dumpFormat: row.dumpFormat as DbDumpFormat,
    totalSize: Number(row.totalSize),
    bytesReceived: Number(row.bytesReceived),
    chunkSize: row.chunkSize,
    status: row.status as 'uploading' | 'complete' | 'cancelled' | 'consumed',
  };
}

async function loadUploadSession(userId: string, uploadId: string) {
  const db = getDb();
  const row = await db.query.dbUploads.findFirst({
    where: and(eq(schema.dbUploads.id, uploadId), eq(schema.dbUploads.userId, userId)),
  });
  if (!row) throw new HttpError(404, 'db dump upload session not found');
  return row;
}

export const dbDumpRoutes = new Hono<AppEnv>();
dbDumpRoutes.use('*', requireAuth);

dbDumpRoutes.post('/upload/init', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const body = initDbUploadRequestSchema.parse(await c.req.json());

  if (body.totalSize > maxUploadBytes()) {
    throw new HttpError(413, `dump exceeds ${maxUploadBytes()} bytes limit`);
  }
  const format = detectDumpFormat(body.filename);

  const uploadDir = path.join(repoStorageRoot(), '_uploads', userId);
  await mkdir(uploadDir, { recursive: true });

  const inserted = await db
    .insert(schema.dbUploads)
    .values({
      userId,
      filename: body.filename,
      dumpFormat: format,
      totalSize: body.totalSize,
      chunkSize: body.chunkSize,
      dumpPath: '',
      status: 'uploading',
    })
    .returning();
  const session = inserted[0]!;

  const ext = dumpDiskExtension(body.filename);
  const dumpPath = path.join(uploadDir, `db-${session.id}.${ext}.partial`);
  const fh = await open(dumpPath, 'w');
  await fh.close();

  const updated = await db
    .update(schema.dbUploads)
    .set({ dumpPath, updatedAt: new Date() })
    .where(eq(schema.dbUploads.id, session.id))
    .returning();

  return c.json({ session: sessionFromRow(updated[0]!) }, 201);
});

dbDumpRoutes.get('/upload/:id', async (c) => {
  const userId = c.get('userId');
  const row = await loadUploadSession(userId, c.req.param('id'));
  return c.json({ session: sessionFromRow(row) });
});

dbDumpRoutes.put('/upload/:id/chunk', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  if (row.status !== 'uploading') {
    throw new HttpError(409, `session is ${row.status}`);
  }

  const rangeHeader = c.req.header('content-range');
  if (!rangeHeader) {
    throw new HttpError(400, 'Content-Range header is required');
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(rangeHeader);
  if (!match) {
    throw new HttpError(400, 'invalid Content-Range header');
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (total !== Number(row.totalSize)) {
    throw new HttpError(400, 'Content-Range total mismatches session totalSize');
  }
  if (start !== Number(row.bytesReceived)) {
    throw new HttpError(409, `expected start=${row.bytesReceived}, got ${start}`);
  }
  const expectedLen = end - start + 1;
  if (expectedLen <= 0) {
    throw new HttpError(400, 'invalid chunk range');
  }
  if (end + 1 > Number(row.totalSize)) {
    throw new HttpError(400, 'chunk end exceeds totalSize');
  }

  // Optimistic claim: only the writer whose `start` matches the current
  // bytesReceived advances the cursor, so concurrent chunk PUTs can't interleave.
  const claim = await db
    .update(schema.dbUploads)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(schema.dbUploads.id, row.id),
        eq(schema.dbUploads.bytesReceived, start),
        eq(schema.dbUploads.status, 'uploading'),
      ),
    )
    .returning({ id: schema.dbUploads.id });
  if (claim.length === 0) {
    throw new HttpError(409, 'chunk races another writer');
  }

  const rawBody = c.req.raw.body;
  if (!rawBody) throw new HttpError(400, 'request body is empty');
  const nodeStream = Readable.fromWeb(rawBody as never);
  const writeStream = createWriteStream(row.dumpPath, { flags: 'a' });
  let written = 0;
  nodeStream.on('data', (buf: Buffer) => {
    written += buf.length;
  });
  try {
    await pipeline(nodeStream, writeStream);
  } catch (err) {
    const fh = await open(row.dumpPath, 'r+');
    try {
      await fh.truncate(Number(row.bytesReceived));
    } finally {
      await fh.close();
    }
    throw new HttpError(500, `chunk write failed: ${(err as Error).message}`);
  }
  if (written !== expectedLen) {
    const fh = await open(row.dumpPath, 'r+');
    try {
      await fh.truncate(Number(row.bytesReceived));
    } finally {
      await fh.close();
    }
    throw new HttpError(400, `chunk body length ${written} != expected ${expectedLen}`);
  }

  const updated = await db
    .update(schema.dbUploads)
    .set({ bytesReceived: end + 1, updatedAt: new Date() })
    .where(eq(schema.dbUploads.id, row.id))
    .returning();

  return c.json({ session: sessionFromRow(updated[0]!) });
});

dbDumpRoutes.post('/upload/:id/complete', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  if (row.status === 'complete') {
    throw new HttpError(409, 'session already completed');
  }
  if (row.status === 'cancelled') {
    throw new HttpError(409, 'session cancelled');
  }
  if (Number(row.bytesReceived) !== Number(row.totalSize)) {
    throw new HttpError(409, `incomplete: ${row.bytesReceived}/${row.totalSize} bytes`);
  }

  const onDisk = await stat(row.dumpPath).catch(() => null);
  if (!onDisk || onDisk.size !== Number(row.totalSize)) {
    throw new HttpError(409, 'dump size mismatch on disk');
  }

  const finalPath = row.dumpPath.replace(/\.partial$/, '');
  if (finalPath === row.dumpPath) {
    throw new HttpError(500, 'dump path missing .partial suffix');
  }
  await rename(row.dumpPath, finalPath);

  // No import job here — the dump waits to be loaded by the task's env-boot /
  // import step, which deletes it immediately after `ddev import-db`.
  await db
    .update(schema.dbUploads)
    .set({ status: 'complete', dumpPath: finalPath, updatedAt: new Date() })
    .where(eq(schema.dbUploads.id, row.id));

  return c.json({ session: { id: row.id, status: 'complete' } }, 201);
});

dbDumpRoutes.delete('/upload/:id', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  await rm(row.dumpPath, { force: true }).catch(() => {});
  await db
    .update(schema.dbUploads)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(schema.dbUploads.id, row.id));

  return c.json({ ok: true });
});
