import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  BUNDLE_JOB_NAMES,
  createGitBundleRequestSchema,
  initBundleUploadRequestSchema,
  type ArchiveFormat,
  type BundleJobPayload,
  type BundleSummary,
  type BundleUploadSession,
  type CustomBundleItemKind,
  type CustomBundleSourceType,
} from '@haive/shared';
import {
  lstatNoFollow,
  openFileNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
} from '@haive/shared/fs-safe';
import { getDb } from '../db.js';
import { getBundleQueue } from '../queues.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { containmentHttpError } from '../lib/fs-http.js';
import {
  ensureUploadsDir,
  truncateUploadFile,
  uploadFileRel,
  uploadFileRelOrThrow,
  uploadsRel,
} from '../lib/uploads.js';

const ARCHIVE_FORMATS = new Set<ArchiveFormat>(['zip', 'tar', 'tar.gz']);

function maxUploadBytes(): number {
  const raw = process.env.MAX_BUNDLE_UPLOAD_BYTES ?? process.env.MAX_UPLOAD_BYTES;
  if (!raw) return 512 * 1024 * 1024; // 512 MiB default — bundles smaller than repos
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 512 * 1024 * 1024;
  return parsed;
}

function detectArchiveFormat(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

function bundleStorageRoot(): string {
  return process.env.BUNDLE_STORAGE_ROOT ?? '/var/lib/haive/bundles';
}

function bundleDirFor(userId: string, bundleId: string): string {
  return path.join(bundleStorageRoot(), userId, bundleId);
}

/**
 * Everything this route touches sits under `bundleStorageRoot()`, in two rel families: the staging
 * dir `_uploads/<userId>/<name>` (the same shape the repo routes use, which is why
 * `lib/uploads.ts` takes the root as a parameter) and the bundle's own `<userId>/<bundleId>/…`.
 *
 * One anchor for both is what makes the archive move a plain `renameNoFollow` with two rels: the
 * staged archive and its destination are on the same volume, so EXDEV cannot arise.
 */
function bundleRel(userId: string, bundleId: string, ...tail: string[]): string {
  return [userId, bundleId, ...tail].join('/');
}

/**
 * A bundle's extracted tree as a rel, or null when the stored root is not one this route can place.
 *
 * `custom_bundles.storage_root` is an ABSOLUTE path that the WORKER rewrites — `bundle-ingest` sets
 * it to the extraction destination and a git bundle's is a clone path — so it is a column this
 * route reads rather than a path it derives. Anything not under `<root>/<userId>/<bundleId>/`
 * answers null and the caller reports an empty tree, which is the answer it already gave for a
 * directory that was not there.
 */
function bundleContentRel(userId: string, bundleId: string, stored: string | null): string | null {
  const base = bundleRel(userId, bundleId);
  if (!stored || stored.length === 0) return `${base}/extracted`;
  const prefix = `${bundleStorageRoot()}/${base}/`;
  if (!stored.startsWith(prefix)) return null;
  const tail = stored.slice(prefix.length).replace(/\/+$/, '');
  if (tail === '' || tail.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  return `${base}/${tail}`;
}

function archiveExt(format: ArchiveFormat): string {
  return format === 'tar.gz' ? 'tar.gz' : format;
}

function parseContentRange(header: string): { start: number; end: number; total: number } | null {
  const m = header.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
}

async function loadBundle(userId: string, bundleId: string) {
  const db = getDb();
  const row = await db.query.customBundles.findFirst({
    where: and(eq(schema.customBundles.id, bundleId), eq(schema.customBundles.userId, userId)),
  });
  if (!row) throw new HttpError(404, 'bundle not found');
  return row;
}

async function loadUploadSession(userId: string, uploadId: string) {
  const db = getDb();
  const row = await db.query.customBundleUploads.findFirst({
    where: and(
      eq(schema.customBundleUploads.id, uploadId),
      eq(schema.customBundleUploads.userId, userId),
    ),
  });
  if (!row) throw new HttpError(404, 'upload session not found');
  return row;
}

function uploadSessionFromRow(
  row: typeof schema.customBundleUploads.$inferSelect,
): BundleUploadSession {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    name: row.name,
    enabledKinds: row.enabledKinds as CustomBundleItemKind[],
    filename: row.filename,
    archiveFormat: row.archiveFormat as ArchiveFormat,
    totalSize: Number(row.totalSize),
    bytesReceived: Number(row.bytesReceived),
    chunkSize: row.chunkSize,
    status: row.status as 'uploading' | 'complete' | 'cancelled',
  };
}

interface ItemCountRow {
  bundleId: string;
  agent: number;
  skill: number;
}

async function loadItemCounts(bundleIds: string[]): Promise<Map<string, ItemCountRow>> {
  const out = new Map<string, ItemCountRow>();
  if (bundleIds.length === 0) return out;
  const db = getDb();
  const rows = await db
    .select({
      bundleId: schema.customBundleItems.bundleId,
      kind: schema.customBundleItems.kind,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.customBundleItems)
    .where(inArray(schema.customBundleItems.bundleId, bundleIds))
    .groupBy(schema.customBundleItems.bundleId, schema.customBundleItems.kind);
  for (const r of rows) {
    const existing = out.get(r.bundleId) ?? { bundleId: r.bundleId, agent: 0, skill: 0 };
    if (r.kind === 'agent') existing.agent = Number(r.count);
    if (r.kind === 'skill') existing.skill = Number(r.count);
    out.set(r.bundleId, existing);
  }
  return out;
}

function bundleSummaryFromRow(
  row: typeof schema.customBundles.$inferSelect,
  counts: ItemCountRow | undefined,
): BundleSummary {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    name: row.name,
    sourceType: row.sourceType as CustomBundleSourceType,
    enabledKinds: row.enabledKinds as CustomBundleItemKind[],
    status: row.status as BundleSummary['status'],
    archiveFilename: row.archiveFilename,
    archiveFormat: (row.archiveFormat as ArchiveFormat | null) ?? null,
    gitUrl: row.gitUrl,
    gitBranch: row.gitBranch,
    gitCredentialsId: row.gitCredentialsId,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastSyncCommit: row.lastSyncCommit,
    lastSyncError: row.lastSyncError,
    itemCounts: { agent: counts?.agent ?? 0, skill: counts?.skill ?? 0 },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertRepositoryOwned(userId: string, repositoryId: string): Promise<void> {
  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'repository not found');
}

async function assertCredentialsOwned(userId: string, credentialsId: string): Promise<void> {
  const db = getDb();
  const cred = await db.query.repoCredentials.findFirst({
    where: and(
      eq(schema.repoCredentials.id, credentialsId),
      eq(schema.repoCredentials.userId, userId),
    ),
    columns: { id: true },
  });
  if (!cred) throw new HttpError(404, 'credentials not found');
}

export const bundleRoutes = new Hono<AppEnv>();

bundleRoutes.use('*', requireAuth);

bundleRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.query('repositoryId');
  const db = getDb();

  const where = repositoryId
    ? and(
        eq(schema.customBundles.userId, userId),
        eq(schema.customBundles.repositoryId, repositoryId),
      )
    : eq(schema.customBundles.userId, userId);

  const rows = await db.query.customBundles.findMany({
    where,
    orderBy: [asc(schema.customBundles.createdAt)],
  });
  const counts = await loadItemCounts(rows.map((r) => r.id));
  const bundles = rows.map((r) => bundleSummaryFromRow(r, counts.get(r.id)));
  return c.json({ bundles });
});

bundleRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);
  const db = getDb();
  const items = await db.query.customBundleItems.findMany({
    where: eq(schema.customBundleItems.bundleId, bundleId),
    orderBy: [asc(schema.customBundleItems.kind), asc(schema.customBundleItems.sourcePath)],
  });
  const counts = await loadItemCounts([bundleId]);
  return c.json({
    bundle: bundleSummaryFromRow(row, counts.get(bundleId)),
    items: items.map((i) => ({
      id: i.id,
      kind: i.kind,
      sourceFormat: i.sourceFormat,
      sourcePath: i.sourcePath,
      contentHash: i.contentHash,
      schemaVersion: i.schemaVersion,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    })),
  });
});

bundleRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = createGitBundleRequestSchema.parse(await c.req.json());
  const db = getDb();

  await assertRepositoryOwned(userId, body.repositoryId);
  if (body.gitCredentialsId) await assertCredentialsOwned(userId, body.gitCredentialsId);

  const inserted = await db
    .insert(schema.customBundles)
    .values({
      userId,
      repositoryId: body.repositoryId,
      name: body.name,
      sourceType: 'git',
      gitUrl: body.gitUrl,
      gitBranch: body.gitBranch ?? 'main',
      gitCredentialsId: body.gitCredentialsId ?? null,
      storageRoot: '',
      enabledKinds: body.enabledKinds,
      status: 'syncing',
    })
    .returning();
  const bundle = inserted[0]!;

  const storageRoot = path.join(bundleDirFor(userId, bundle.id), 'extracted');
  await db
    .update(schema.customBundles)
    .set({ storageRoot, updatedAt: new Date() })
    .where(eq(schema.customBundles.id, bundle.id));

  const queue = getBundleQueue();
  const payload: BundleJobPayload = { bundleId: bundle.id, userId };
  await queue.add(BUNDLE_JOB_NAMES.INGEST_GIT, payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  const counts = await loadItemCounts([bundle.id]);
  return c.json(
    { bundle: bundleSummaryFromRow({ ...bundle, storageRoot }, counts.get(bundle.id)) },
    201,
  );
});

bundleRoutes.post('/uploads/init', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const body = initBundleUploadRequestSchema.parse(await c.req.json());

  await assertRepositoryOwned(userId, body.repositoryId);

  if (body.totalSize > maxUploadBytes()) {
    throw new HttpError(413, `archive exceeds ${maxUploadBytes()} bytes limit`);
  }
  const format = detectArchiveFormat(body.filename);
  if (!format || !ARCHIVE_FORMATS.has(format)) {
    throw new HttpError(400, 'unsupported archive format (allowed: .zip, .tar, .tar.gz, .tgz)');
  }

  const anchor = await ensureUploadsDir(userId, bundleStorageRoot());

  const inserted = await db
    .insert(schema.customBundleUploads)
    .values({
      userId,
      repositoryId: body.repositoryId,
      name: body.name,
      enabledKinds: body.enabledKinds,
      filename: body.filename,
      archiveFormat: format,
      totalSize: body.totalSize,
      bytesReceived: 0,
      chunkSize: body.chunkSize,
      archivePath: '',
      status: 'uploading',
    })
    .returning();
  const session = inserted[0]!;

  const archiveRel = `${uploadsRel(userId)}/${session.id}.${archiveExt(format)}.partial`;
  const archivePath = path.join(anchor, archiveRel);
  // `open(path, 'w')` truncated whatever stood at the name, a link included. The name embeds a
  // fresh session id, so exclusive creation is the same outcome for every legitimate call.
  const fh = await openFileNoFollow(anchor, archiveRel, 'create-exclusive', { fileMode: 0o644 });
  await fh.close();

  const updated = await db
    .update(schema.customBundleUploads)
    .set({ archivePath, updatedAt: new Date() })
    .where(eq(schema.customBundleUploads.id, session.id))
    .returning();

  return c.json({ session: uploadSessionFromRow(updated[0]!) }, 201);
});

bundleRoutes.get('/uploads/:id', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const row = await loadUploadSession(userId, uploadId);
  return c.json({ session: uploadSessionFromRow(row) });
});

bundleRoutes.put('/uploads/:id/chunk', async (c) => {
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
  const range = parseContentRange(rangeHeader);
  if (!range) {
    throw new HttpError(400, 'invalid Content-Range header');
  }
  const { start, end, total } = range;
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

  const claim = await db
    .update(schema.customBundleUploads)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(schema.customBundleUploads.id, row.id),
        eq(schema.customBundleUploads.bytesReceived, start),
        eq(schema.customBundleUploads.status, 'uploading'),
      ),
    )
    .returning({ id: schema.customBundleUploads.id });
  if (claim.length === 0) {
    throw new HttpError(409, 'chunk races another writer');
  }

  const rawBody = c.req.raw.body;
  if (!rawBody) throw new HttpError(400, 'request body is empty');
  const anchor = bundleStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Bundle archive', anchor);
  const nodeStream = Readable.fromWeb(rawBody as never);
  // Written at the session's OWN offset instead of with `flags: 'a'`: the offset is the fact the
  // row already tracks and the claim above just verified, where appending trusted the file's
  // current length. MEASURED on node v26.7.0, `createWriteStream({ start })` positions the write.
  const fh = await openFileNoFollow(anchor, archiveRel, 'read-write', { strict: true }).catch(
    (err: unknown) => containmentHttpError(err, 'Bundle archive is outside the uploads directory'),
  );
  if (!fh) throw new HttpError(409, 'Bundle archive is missing on disk');
  let written = 0;
  nodeStream.on('data', (buf: Buffer) => {
    written += buf.length;
  });
  try {
    await pipeline(nodeStream, fh.createWriteStream({ start }));
  } catch (err) {
    await truncateUploadFile(anchor, archiveRel, Number(row.bytesReceived));
    throw new HttpError(500, `chunk write failed: ${(err as Error).message}`);
  }
  if (written !== expectedLen) {
    await truncateUploadFile(anchor, archiveRel, Number(row.bytesReceived));
    throw new HttpError(400, `chunk body length ${written} != expected ${expectedLen}`);
  }

  const updated = await db
    .update(schema.customBundleUploads)
    .set({ bytesReceived: end + 1, updatedAt: new Date() })
    .where(eq(schema.customBundleUploads.id, row.id))
    .returning();

  return c.json({ session: uploadSessionFromRow(updated[0]!) });
});

bundleRoutes.post('/uploads/:id/complete', async (c) => {
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

  const anchor = bundleStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Bundle archive', anchor);
  // A link at that name now fails this check rather than reporting its target's size.
  const onDisk = await lstatNoFollow(anchor, archiveRel);
  if (!onDisk || onDisk.kind !== 'file' || onDisk.stats.size !== Number(row.totalSize)) {
    throw new HttpError(409, 'archive size mismatch on disk');
  }

  // Create the bundle row first so we know the bundleId; then move the staged
  // archive into the bundle's per-bundle directory.
  const inserted = await db
    .insert(schema.customBundles)
    .values({
      userId,
      repositoryId: row.repositoryId,
      name: row.name,
      sourceType: 'zip',
      archiveFilename: row.filename,
      archiveFormat: row.archiveFormat,
      storageRoot: '',
      enabledKinds: row.enabledKinds,
      status: 'syncing',
    })
    .returning();
  const bundle = inserted[0]!;

  const bundleDir = bundleDirFor(userId, bundle.id);
  const finalRel = bundleRel(
    userId,
    bundle.id,
    `source.${archiveExt(row.archiveFormat as ArchiveFormat)}`,
  );
  const finalArchive = path.join(anchor, finalRel);
  const storageRoot = path.join(bundleDir, 'extracted');

  try {
    // `createParents` walks the bundle directory into place, which is what the separate `mkdir`
    // did — and both rels sit under the same anchor, so this move cannot cross a filesystem.
    await renameNoFollow(anchor, archiveRel, finalRel, { createParents: true });
  } catch (err) {
    await db.delete(schema.customBundles).where(eq(schema.customBundles.id, bundle.id));
    throw new HttpError(500, `failed to move archive: ${(err as Error).message}`);
  }

  await db
    .update(schema.customBundles)
    .set({ archivePath: finalArchive, storageRoot, updatedAt: new Date() })
    .where(eq(schema.customBundles.id, bundle.id));

  await db
    .update(schema.customBundleUploads)
    .set({
      status: 'complete',
      bundleId: bundle.id,
      archivePath: finalArchive,
      updatedAt: new Date(),
    })
    .where(eq(schema.customBundleUploads.id, row.id));

  const queue = getBundleQueue();
  const payload: BundleJobPayload = {
    bundleId: bundle.id,
    userId,
    archivePath: finalArchive,
    archiveFormat: row.archiveFormat as ArchiveFormat,
  };
  await queue.add(BUNDLE_JOB_NAMES.INGEST_ZIP, payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  const counts = await loadItemCounts([bundle.id]);
  return c.json(
    {
      bundle: bundleSummaryFromRow(
        { ...bundle, archivePath: finalArchive, storageRoot },
        counts.get(bundle.id),
      ),
      session: { id: row.id, status: 'complete' as const },
    },
    201,
  );
});

bundleRoutes.delete('/uploads/:id', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  if (row.archivePath) {
    // Cancelling must succeed whatever the row's path looks like, so a refused shape only skips the
    // unlink: the session is still cancelled, and a leftover partial is the sweeper's problem.
    const anchor = bundleStorageRoot();
    const archiveRel = uploadFileRel(userId, row.archivePath, anchor);
    if (archiveRel) await removeNoFollow(anchor, archiveRel).catch(() => {});
  }
  await db
    .update(schema.customBundleUploads)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(schema.customBundleUploads.id, row.id));

  return c.json({ ok: true });
});

/** Replace the archive of an existing ZIP-source bundle. Mirrors the
 *  init/chunk/complete pattern but pre-binds the upload session to a bundle
 *  via `bundleId` at init time, and on complete swaps the staged archive
 *  into the bundle's `source.zip` and re-runs ingest. */
bundleRoutes.post('/:id/replace/init', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const bundle = await loadBundle(userId, bundleId);
  if (bundle.sourceType !== 'zip') {
    throw new HttpError(400, 'only zip-source bundles support archive replace');
  }
  const db = getDb();
  const body = (await c.req.json()) as {
    filename?: unknown;
    totalSize?: unknown;
    chunkSize?: unknown;
  };
  if (typeof body.filename !== 'string' || body.filename.length === 0) {
    throw new HttpError(400, 'filename is required');
  }
  const totalSize = Number(body.totalSize);
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    throw new HttpError(400, 'totalSize must be a positive integer');
  }
  const chunkSize = Number(body.chunkSize);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new HttpError(400, 'chunkSize must be a positive integer');
  }
  if (totalSize > maxUploadBytes()) {
    throw new HttpError(413, `archive exceeds ${maxUploadBytes()} bytes limit`);
  }
  const format = detectArchiveFormat(body.filename);
  if (!format || !ARCHIVE_FORMATS.has(format)) {
    throw new HttpError(400, 'unsupported archive format (allowed: .zip, .tar, .tar.gz, .tgz)');
  }

  const anchor = await ensureUploadsDir(userId, bundleStorageRoot());

  const inserted = await db
    .insert(schema.customBundleUploads)
    .values({
      userId,
      bundleId,
      repositoryId: bundle.repositoryId,
      name: bundle.name,
      enabledKinds: bundle.enabledKinds,
      filename: body.filename,
      archiveFormat: format,
      totalSize,
      bytesReceived: 0,
      chunkSize,
      archivePath: '',
      status: 'uploading',
    })
    .returning();
  const session = inserted[0]!;
  const archiveRel = `${uploadsRel(userId)}/${session.id}.${archiveExt(format)}.partial`;
  const archivePath = path.join(anchor, archiveRel);
  // `open(path, 'w')` truncated whatever stood at the name, a link included. The name embeds a
  // fresh session id, so exclusive creation is the same outcome for every legitimate call.
  const fh = await openFileNoFollow(anchor, archiveRel, 'create-exclusive', { fileMode: 0o644 });
  await fh.close();
  const updated = await db
    .update(schema.customBundleUploads)
    .set({ archivePath, updatedAt: new Date() })
    .where(eq(schema.customBundleUploads.id, session.id))
    .returning();
  return c.json({ session: uploadSessionFromRow(updated[0]!) }, 201);
});

bundleRoutes.post('/:id/replace/:uploadId/complete', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const uploadId = c.req.param('uploadId');
  const db = getDb();

  const bundle = await loadBundle(userId, bundleId);
  if (bundle.sourceType !== 'zip') {
    throw new HttpError(400, 'only zip-source bundles support archive replace');
  }
  const row = await loadUploadSession(userId, uploadId);
  if (row.bundleId !== bundleId) {
    throw new HttpError(400, 'upload session is not bound to this bundle');
  }
  if (row.status === 'complete') {
    throw new HttpError(409, 'session already completed');
  }
  if (row.status === 'cancelled') {
    throw new HttpError(409, 'session cancelled');
  }
  if (Number(row.bytesReceived) !== Number(row.totalSize)) {
    throw new HttpError(409, `incomplete: ${row.bytesReceived}/${row.totalSize} bytes`);
  }
  const anchor = bundleStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Bundle archive', anchor);
  const onDisk = await lstatNoFollow(anchor, archiveRel);
  if (!onDisk || onDisk.kind !== 'file' || onDisk.stats.size !== Number(row.totalSize)) {
    throw new HttpError(409, 'archive size mismatch on disk');
  }

  const dir = bundleDirFor(userId, bundleId);
  const finalRel = bundleRel(
    userId,
    bundleId,
    `source.${archiveExt(row.archiveFormat as ArchiveFormat)}`,
  );
  const extractedRel = bundleRel(userId, bundleId, 'extracted');
  const finalArchive = path.join(anchor, finalRel);
  const newExtracted = path.join(dir, 'extracted');

  // Wipe the prior extracted/ tree and overwrite source.<ext>. Keeping the
  // bundle row + items table intact during the swap means the UI can keep
  // displaying the previous state until the worker re-parses.
  await removeNoFollow(anchor, extractedRel, { recursive: true });
  await removeNoFollow(anchor, finalRel).catch(() => {});
  await renameNoFollow(anchor, archiveRel, finalRel, { createParents: true });

  await db
    .update(schema.customBundles)
    .set({
      archiveFilename: row.filename,
      archiveFormat: row.archiveFormat,
      archivePath: finalArchive,
      storageRoot: newExtracted,
      status: 'syncing',
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.customBundles.id, bundleId));

  await db
    .update(schema.customBundleUploads)
    .set({
      status: 'complete',
      archivePath: finalArchive,
      updatedAt: new Date(),
    })
    .where(eq(schema.customBundleUploads.id, row.id));

  const queue = getBundleQueue();
  const payload: BundleJobPayload = {
    bundleId,
    userId,
    archivePath: finalArchive,
    archiveFormat: row.archiveFormat as ArchiveFormat,
  };
  await queue.add(BUNDLE_JOB_NAMES.INGEST_ZIP, payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  const counts = await loadItemCounts([bundleId]);
  return c.json({
    bundle: bundleSummaryFromRow(
      { ...bundle, archivePath: finalArchive, storageRoot: newExtracted, status: 'syncing' },
      counts.get(bundleId),
    ),
    session: { id: row.id, status: 'complete' as const },
  });
});

bundleRoutes.post('/:id/sync', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);
  if (row.sourceType !== 'git') {
    throw new HttpError(400, 'only git-source bundles can be resynced');
  }

  const db = getDb();
  await db
    .update(schema.customBundles)
    .set({ status: 'syncing', lastSyncError: null, updatedAt: new Date() })
    .where(eq(schema.customBundles.id, bundleId));

  const queue = getBundleQueue();
  const payload: BundleJobPayload = { bundleId, userId };
  await queue.add(BUNDLE_JOB_NAMES.RESYNC_GIT, payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  return c.json({ ok: true, bundleId });
});

/** Lazy file browser for a bundle's extracted/ tree. Returns flat
 *  `[{path,size}]` pairs (UI groups by `/`). Skips `.git/` to keep git-sourced
 *  bundles small and avoid leaking pack contents. Caps at 5000 entries to
 *  keep the response bounded; truncated flag tells the UI to warn the user. */
const FILES_LIST_CAP = 5000;

async function listExtractedFiles(
  anchor: string,
  rootRel: string,
): Promise<{
  files: Array<{ path: string; size: number }>;
  truncated: boolean;
}> {
  const out: Array<{ path: string; size: number }> = [];
  let truncated = false;
  const walk = async (relDir: string, rel: string): Promise<void> => {
    if (out.length >= FILES_LIST_CAP) {
      truncated = true;
      return;
    }
    // Lenient: a directory that cannot be listed — absent, unreadable, or a link standing where a
    // directory should be — contributes nothing, which is exactly what the `catch` here did.
    const entries = await readdirNoFollow(anchor, relDir);
    if (entries === null) return;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= FILES_LIST_CAP) {
        truncated = true;
        return;
      }
      if (entry.name === '.git') continue;
      if (entry.name === '.DS_Store') continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(`${relDir}/${entry.name}`, childRel);
        continue;
      }
      // `readdir` LISTS a link, and the `stat` this replaced then followed it — so a link in the
      // extracted tree was reported as a file of the target's size, which is not a file this
      // bundle holds. The lstat answers for the entry itself.
      if (!entry.isFile()) continue;
      const info = await lstatNoFollow(anchor, `${relDir}/${entry.name}`);
      if (info?.kind !== 'file') continue;
      out.push({ path: childRel, size: Number(info.stats.size) });
    }
  };
  await walk(rootRel, '');
  return { files: out, truncated };
}

bundleRoutes.get('/:id/files', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);
  const anchor = bundleStorageRoot();
  const rootRel = bundleContentRel(userId, bundleId, row.storageRoot);
  // A stored root this route cannot place reads as an empty tree, the same answer a missing
  // directory already gave — the listing is a convenience, not a contract about what exists.
  if (rootRel === null) return c.json({ files: [], truncated: false });
  const exists = await lstatNoFollow(anchor, rootRel);
  if (exists?.kind !== 'directory') {
    return c.json({ files: [], truncated: false });
  }
  const result = await listExtractedFiles(anchor, rootRel);
  return c.json(result);
});

bundleRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);
  const db = getDb();

  // Wipe on-disk artefacts before dropping the row so a partial cleanup can
  // be retried by the user via the same DELETE.
  await removeNoFollow(bundleStorageRoot(), bundleRel(userId, bundleId), {
    recursive: true,
    repairPermissions: true,
  }).catch(() => {});

  await db.delete(schema.customBundles).where(eq(schema.customBundles.id, row.id));
  return c.json({ ok: true });
});
