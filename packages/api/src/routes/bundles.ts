import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Hono } from 'hono';
import { credentialFitsGitRemote, redactGitText, redactGitUrl } from '@haive/shared/schemas';
import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
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
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { getDb } from '../db.js';
import { getBundleQueue } from '../queues.js';
import { requireAuth } from '../middleware/auth.js';
import {
  admitNewWork,
  assertNewWorkAllowed,
  requireNewWorkAllowed,
} from '../middleware/maintenance.js';
import { HttpError, type AppEnv } from '../context.js';
import { containmentHttpError } from '../lib/fs-http.js';
import { writeBodyToHeld } from '../lib/held-write.js';
import { requireJsonObject } from '../lib/json-object.js';
import { withUploadChunkLock } from '../lib/upload-chunk-lock.js';
import {
  cancelUploadSession,
  isSessionOver,
  isWholeFile,
  withCompleteClaim,
} from '../lib/upload-complete-claim.js';
import {
  ensureUploadsDir,
  uploadFileRel,
  uploadFileRelOrThrow,
  uploadsRel,
} from '../lib/uploads.js';
import { isUuid } from '../lib/uuid.js';
import {
  placeReplacementArchive,
  discardReplacementArchive,
  replacementArchiveRel,
  BundleReplacementError,
} from '@haive/shared/bundle-replacement';

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
    status: row.status as
      'uploading' | 'completing' | 'complete' | 'cancelled' | 'reaping' | 'reap_failed',
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
    gitUrl: row.gitUrl ? redactGitUrl(row.gitUrl) : null,
    gitBranch: row.gitBranch,
    gitCredentialsId: row.gitCredentialsId,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastSyncCommit: row.lastSyncCommit,
    lastSyncError: row.lastSyncError ? redactGitText(row.lastSyncError) : row.lastSyncError,
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

async function assertCredentialsFit(
  userId: string,
  credentialsId: string,
  remoteUrl: string,
): Promise<void> {
  const db = getDb();
  const cred = await db.query.repoCredentials.findFirst({
    where: and(
      eq(schema.repoCredentials.id, credentialsId),
      eq(schema.repoCredentials.userId, userId),
    ),
    columns: { id: true, host: true },
  });
  if (!cred) throw new HttpError(404, 'credentials not found');
  if (!credentialFitsGitRemote(cred, remoteUrl))
    throw new HttpError(400, 'The Git credential does not fit the bundle remote.');
}

export const bundleRoutes = new Hono<AppEnv>();

bundleRoutes.use('*', requireAuth);

bundleRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const repositoryId = c.req.query('repositoryId');
  if (repositoryId && !isUuid(repositoryId)) {
    throw new HttpError(400, 'repositoryId must be a UUID');
  }
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

async function deleteBundleRow(bundleId: string, repositoryId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.delete(schema.customBundles).where(eq(schema.customBundles.id, bundleId));
    await markProjectStateDirty(tx, repositoryId);
  });
}

/** A failed row may still owe a job whose enqueue acknowledgement was lost. This read runs
 * under the winning row update's lock; a duplicate admission rolls back without changing copy.
 * A capped or unavailable queue read is unknown, never evidence that the bundle has no job. */
async function refuseLiveBundleJob(
  queue: ReturnType<typeof getBundleQueue>,
  bundleId: string,
): Promise<void> {
  const limit = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: { ids: string[]; jobs: Array<Awaited<ReturnType<typeof queue.getJob>>> };
  try {
    snapshot = await Promise.race([
      (async () => {
        // getJobs re-hydrates and filters missing hashes after its Lua snapshot. Its returned
        // length cannot prove completeness. Keep the public range API's atomic IDs instead.
        const ids = await queue.getRanges(
          ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'],
          0,
          limit - 1,
        );
        const jobs =
          ids.length >= limit ? [] : await Promise.all(ids.map((id) => queue.getJob(id)));
        return { ids, jobs };
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('bundle queue lookup timed out')), 5000);
        timer.unref();
      }),
    ]);
  } catch {
    throw new HttpError(
      503,
      'Could not check whether this bundle already has an import job. Try again shortly.',
    );
  } finally {
    clearTimeout(timer);
  }
  if (snapshot.ids.length >= limit) {
    throw new HttpError(
      503,
      'The bundle queue is too busy to verify another import safely. Try again shortly.',
    );
  }
  if (snapshot.jobs.some((job) => !job)) {
    throw new HttpError(
      503,
      'The bundle queue changed while checking its import jobs. Try again shortly.',
    );
  }
  if (snapshot.jobs.some((job) => job?.data?.bundleId === bundleId)) {
    throw new HttpError(409, 'an import of this bundle is already queued or running');
  }
}

async function addBundleJobOrMarkFailed(
  db: ReturnType<typeof getDb>,
  bundleId: string,
  add: () => Promise<unknown>,
  fence?: SQL,
): Promise<void> {
  try {
    await add();
  } catch (err) {
    await db
      .update(schema.customBundles)
      .set({
        status: 'failed',
        lastSyncError:
          'Could not queue the job that imports this bundle. Use Resync (git) or Replace ZIP to try again, or remove the bundle.',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.customBundles.id, bundleId),
          eq(schema.customBundles.status, 'syncing'),
          fence,
        ),
      )
      .catch(() => undefined);
    throw err;
  }
}

async function completedUploadBody(userId: string, sessionId: string) {
  const bundle = await loadBundle(userId, sessionId);
  const counts = await loadItemCounts([bundle.id]);
  return {
    bundle: bundleSummaryFromRow(bundle, counts.get(bundle.id)),
    session: { id: sessionId, status: 'complete' as const },
  };
}

bundleRoutes.post('/', requireNewWorkAllowed, async (c) => {
  const userId = c.get('userId');
  const body = createGitBundleRequestSchema.parse(await c.req.json());
  const db = getDb();

  await assertRepositoryOwned(userId, body.repositoryId);
  if (body.gitCredentialsId) await assertCredentialsFit(userId, body.gitCredentialsId, body.gitUrl);

  // Chosen before the insert so the row is never visible with an empty storage_root.
  const bundleId = randomUUID();
  const storageRoot = path.join(bundleDirFor(userId, bundleId), 'extracted');
  const bundle = await db.transaction(async (tx) => {
    await admitNewWork(tx);
    const [row] = await tx
      .insert(schema.customBundles)
      .values({
        id: bundleId,
        userId,
        repositoryId: body.repositoryId,
        name: body.name,
        sourceType: 'git',
        gitUrl: body.gitUrl,
        gitBranch: body.gitBranch ?? 'main',
        gitCredentialsId: body.gitCredentialsId ?? null,
        storageRoot,
        enabledKinds: body.enabledKinds,
        status: 'syncing',
      })
      .returning();
    await markProjectStateDirty(tx, body.repositoryId);
    return row!;
  });

  const queue = getBundleQueue();
  const payload: BundleJobPayload = { bundleId: bundle.id, userId };
  await addBundleJobOrMarkFailed(db, bundle.id, () =>
    queue.add(BUNDLE_JOB_NAMES.INGEST_GIT, payload, {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    }),
  );

  const counts = await loadItemCounts([bundle.id]);
  return c.json({ bundle: bundleSummaryFromRow(bundle, counts.get(bundle.id)) }, 201);
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

  const sessionId = randomUUID();
  const archiveRel = `${uploadsRel(userId)}/${sessionId}.${archiveExt(format)}.partial`;
  const archivePath = path.join(anchor, archiveRel);

  const inserted = await db
    .insert(schema.customBundleUploads)
    .values({
      id: sessionId,
      userId,
      repositoryId: body.repositoryId,
      name: body.name,
      enabledKinds: body.enabledKinds,
      filename: body.filename,
      archiveFormat: format,
      totalSize: body.totalSize,
      bytesReceived: 0,
      chunkSize: body.chunkSize,
      archivePath,
      status: 'uploading',
    })
    .returning();

  // `open(path, 'w')` truncated whatever stood at the name, a link included. The name embeds a
  // fresh session id, so exclusive creation is the same outcome for every legitimate call.
  const fh = await openFileNoFollow(anchor, archiveRel, 'create-exclusive', { fileMode: 0o644 });
  await fh.close();

  return c.json({ session: uploadSessionFromRow(inserted[0]!) }, 201);
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

  const updated = await withUploadChunkLock(db, 'bundle', row.id, async (tx) => {
    const claim = await tx
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
    // Written at the session's OWN offset instead of with `flags: 'a'`: the offset is the fact the
    // row already tracks and the claim above just verified, where appending trusted the file's
    // current length. Rolled back through this same descriptor, never through the name.
    const fh = await openFileNoFollow(anchor, archiveRel, 'read-write', { strict: true }).catch(
      (err: unknown) =>
        containmentHttpError(err, 'Bundle archive is outside the uploads directory'),
    );
    if (!fh) throw new HttpError(409, 'Bundle archive is missing on disk');
    try {
      const written = await writeBodyToHeld(
        rawBody,
        fh,
        expectedLen,
        () => new HttpError(400, `chunk body length exceeds expected ${expectedLen}`),
        start,
      );
      if (written !== expectedLen) {
        throw new HttpError(400, `chunk body length ${written} != expected ${expectedLen}`);
      }
      await fh.close();
    } catch (err) {
      await fh.truncate(Number(row.bytesReceived)).catch(() => {});
      await fh.close().catch(() => {});
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `chunk write failed: ${(err as Error).message}`);
    }

    const advanced = await tx
      .update(schema.customBundleUploads)
      .set({ bytesReceived: end + 1, updatedAt: new Date() })
      .where(
        and(
          eq(schema.customBundleUploads.id, row.id),
          eq(schema.customBundleUploads.status, 'uploading'),
        ),
      )
      .returning();
    if (advanced.length === 0) {
      throw new HttpError(409, 'session is no longer uploading');
    }
    return advanced;
  });

  return c.json({ session: uploadSessionFromRow(updated[0]!) });
});

bundleRoutes.post('/uploads/:id/complete', requireNewWorkAllowed, async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  if (row.bundleId !== null && row.bundleId !== row.id) {
    throw new HttpError(400, 'upload session replaces the archive of a bundle');
  }
  if (row.status === 'complete') {
    return c.json(await completedUploadBody(userId, row.id));
  }
  if (isSessionOver(row.status)) {
    throw new HttpError(409, 'session cancelled');
  }
  if (Number(row.bytesReceived) !== Number(row.totalSize)) {
    throw new HttpError(409, `incomplete: ${row.bytesReceived}/${row.totalSize} bytes`);
  }

  const anchor = bundleStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Bundle archive', anchor);
  const finalRel = bundleRel(
    userId,
    row.id,
    `source.${archiveExt(row.archiveFormat as ArchiveFormat)}`,
  );
  const finalArchive = path.join(anchor, finalRel);
  const wholeFileAt = (rel: string) => isWholeFile(anchor, rel, Number(row.totalSize));

  // The claim is a write, so a drain that began after the early check refuses before it.
  await assertNewWorkAllowed();
  await withCompleteClaim(db, schema.customBundleUploads, row.id, async (claim) => {
    const staged = await wholeFileAt(archiveRel);
    if (!staged && !(await wholeFileAt(finalRel))) {
      throw new HttpError(409, 'archive size mismatch on disk');
    }

    // Create the bundle row first, under the upload's id so a repeated complete finds it, with its
    // storage_root and archive_path; then move the staged archive into the bundle's directory.
    const inserted = await db.transaction(async (tx) => {
      await admitNewWork(tx);
      const [created] = await tx
        .insert(schema.customBundles)
        .values({
          id: row.id,
          userId,
          repositoryId: row.repositoryId,
          name: row.name,
          sourceType: 'zip',
          archiveFilename: row.filename,
          archiveFormat: row.archiveFormat,
          archivePath: finalArchive,
          storageRoot: path.join(bundleDirFor(userId, row.id), 'extracted'),
          enabledKinds: row.enabledKinds,
          status: 'syncing',
        })
        .onConflictDoNothing({ target: schema.customBundles.id })
        .returning();
      await claim.write(tx, { bundleId: row.id });
      if (created) await markProjectStateDirty(tx, row.repositoryId);
      return created;
    });

    if (staged) {
      try {
        // `createParents` walks the bundle directory into place, which is what the separate `mkdir`
        // did — and both rels sit under the same anchor, so this move cannot cross a filesystem.
        await renameNoFollow(anchor, archiveRel, finalRel, { createParents: true });
      } catch (err) {
        if (!(await wholeFileAt(finalRel))) {
          throw new HttpError(500, `failed to move archive: ${(err as Error).message}`);
        }
      }
    }

    const queue = getBundleQueue();
    const jobId = `ingest-zip-${row.id}`;
    if (inserted || !(await queue.getJob(jobId))) {
      if (!inserted) {
        await db.transaction(async (tx) => {
          await admitNewWork(tx);
          await tx
            .update(schema.customBundles)
            .set({ status: 'syncing', lastSyncError: null, updatedAt: new Date() })
            .where(
              and(
                eq(schema.customBundles.id, row.id),
                inArray(schema.customBundles.status, ['syncing', 'failed']),
              ),
            );
        });
      }
      const payload: BundleJobPayload = {
        bundleId: row.id,
        userId,
        archivePath: finalArchive,
        archiveFormat: row.archiveFormat as ArchiveFormat,
      };
      await addBundleJobOrMarkFailed(db, row.id, () =>
        queue.add(BUNDLE_JOB_NAMES.INGEST_ZIP, payload, {
          jobId,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        }),
      );
    }

    await claim.write(db, { status: 'complete', archivePath: finalArchive, updatedAt: new Date() });
  });

  return c.json(await completedUploadBody(userId, row.id), 201);
});

bundleRoutes.delete('/uploads/:id', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  if (row.status !== 'uploading') {
    throw new HttpError(409, `session is ${row.status}`);
  }
  // Cancelling must succeed whatever the row's path looks like, so a refused shape only skips the
  // unlink: the session is still cancelled, and the upload reaper removes a leftover partial.
  const anchor = bundleStorageRoot();
  const archiveRel = uploadFileRel(userId, row.archivePath, anchor);
  await cancelUploadSession(
    db,
    schema.customBundleUploads,
    row.id,
    anchor,
    [archiveRel],
    async () => {
      if (archiveRel && row.bundleId && row.bundleId !== row.id) {
        const finalRel = replacementArchiveRel(userId, row.bundleId, row.id, row.archiveFormat);
        const current = await db.query.customBundles.findFirst({
          where: eq(schema.customBundles.id, row.bundleId),
        });
        if (current?.archivePath !== path.join(anchor, finalRel)) {
          await discardReplacementArchive(anchor, archiveRel, finalRel, Number(row.totalSize));
        }
      }
    },
  );

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
  const body = requireJsonObject<{
    filename?: unknown;
    totalSize?: unknown;
    chunkSize?: unknown;
  }>(await c.req.json());
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

  const sessionId = randomUUID();
  const archiveRel = `${uploadsRel(userId)}/${sessionId}.${archiveExt(format)}.partial`;
  const archivePath = path.join(anchor, archiveRel);

  const inserted = await db
    .insert(schema.customBundleUploads)
    .values({
      id: sessionId,
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
      archivePath,
      status: 'uploading',
    })
    .returning();
  // `open(path, 'w')` truncated whatever stood at the name, a link included. The name embeds a
  // fresh session id, so exclusive creation is the same outcome for every legitimate call.
  const fh = await openFileNoFollow(anchor, archiveRel, 'create-exclusive', { fileMode: 0o644 });
  await fh.close();
  return c.json({ session: uploadSessionFromRow(inserted[0]!) }, 201);
});

bundleRoutes.post('/:id/replace/:uploadId/complete', requireNewWorkAllowed, async (c) => {
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
    const counts = await loadItemCounts([bundleId]);
    return c.json({
      bundle: bundleSummaryFromRow(bundle, counts.get(bundleId)),
      session: { id: row.id, status: 'complete' as const },
    });
  }
  if (isSessionOver(row.status)) {
    throw new HttpError(409, 'session cancelled');
  }
  if (Number(row.bytesReceived) !== Number(row.totalSize)) {
    throw new HttpError(409, `incomplete: ${row.bytesReceived}/${row.totalSize} bytes`);
  }
  const anchor = bundleStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Bundle archive', anchor);
  const finalRel = replacementArchiveRel(userId, bundleId, row.id, row.archiveFormat);
  const finalArchive = path.join(anchor, finalRel);
  const newExtracted = path.join(bundleDirFor(userId, bundleId), 'extracted');
  await assertNewWorkAllowed();
  await withCompleteClaim(db, schema.customBundleUploads, row.id, async (claim) => {
    try {
      await placeReplacementArchive(anchor, archiveRel, finalRel, Number(row.totalSize));
    } catch (err) {
      if (err instanceof BundleReplacementError) throw new HttpError(409, err.message);
      throw err;
    }
    const queue = getBundleQueue();
    const jobId = `ingest-zip-${row.id}`;
    const existing = await queue.getJob(jobId);
    const state = existing ? await existing.getState() : null;
    if (state !== null && state !== 'failed' && state !== 'unknown') {
      // A prior attempt enqueued before losing its response. Its worker owns the extracted tree.
      await claim.write(db, {
        status: 'complete',
        archivePath: finalArchive,
        updatedAt: new Date(),
      });
      return;
    }
    await db.transaction(async (tx) => {
      await admitNewWork(tx);
      // A different replace may have won since the pre-read. Only this source can resume syncing.
      const [promoted] = await tx
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
        .where(
          and(
            eq(schema.customBundles.id, bundleId),
            or(
              ne(schema.customBundles.status, 'syncing'),
              eq(schema.customBundles.archivePath, finalArchive),
            ),
          ),
        )
        .returning({ id: schema.customBundles.id });
      if (!promoted) throw new HttpError(409, 'another import of this bundle is already running');
      await refuseLiveBundleJob(queue, bundleId);
      // Fence promotion to the held upload; a takeover rolls the transaction back.
      await claim.write(tx, { bundleId });
    });
    await db.transaction(async (tx) => {
      // Keep the same lock order as promotion: bundle, then upload. A stale complete cannot
      // remove a tree that a takeover's worker is now parsing.
      const [current] = await tx
        .select({ archivePath: schema.customBundles.archivePath })
        .from(schema.customBundles)
        .where(eq(schema.customBundles.id, bundleId))
        .for('update');
      if (current?.archivePath !== finalArchive)
        throw new HttpError(409, 'bundle source changed during completion');
      await claim.write(tx, { bundleId });
      await removeNoFollow(anchor, bundleRel(userId, bundleId, 'extracted'), { recursive: true });
    });
    if (existing) await existing.remove();
    const payload: BundleJobPayload = {
      bundleId,
      userId,
      archivePath: finalArchive,
      archiveFormat: row.archiveFormat as ArchiveFormat,
    };
    await addBundleJobOrMarkFailed(
      db,
      bundleId,
      () =>
        queue.add(BUNDLE_JOB_NAMES.INGEST_ZIP, payload, {
          jobId,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        }),
      eq(schema.customBundles.archivePath, finalArchive),
    );
    await claim.write(db, { status: 'complete', archivePath: finalArchive, updatedAt: new Date() });
  });
  const current = await loadBundle(userId, bundleId);
  const counts = await loadItemCounts([bundleId]);
  return c.json({
    bundle: bundleSummaryFromRow(current, counts.get(bundleId)),
    session: { id: row.id, status: 'complete' as const },
  });
});

bundleRoutes.post('/:id/sync', requireNewWorkAllowed, async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);
  if (row.sourceType !== 'git') {
    throw new HttpError(400, 'only git-source bundles can be resynced');
  }

  const db = getDb();
  const queue = getBundleQueue();
  const syncingAt = new Date();
  await db.transaction(async (tx) => {
    await admitNewWork(tx);
    const [taken] = await tx
      .update(schema.customBundles)
      .set({ status: 'syncing', lastSyncError: null, updatedAt: syncingAt })
      .where(and(eq(schema.customBundles.id, bundleId), ne(schema.customBundles.status, 'syncing')))
      .returning({ id: schema.customBundles.id });
    if (!taken) throw new HttpError(409, 'an import of this bundle is already running');
    await refuseLiveBundleJob(queue, bundleId);
  });

  const payload: BundleJobPayload = { bundleId, userId };
  await addBundleJobOrMarkFailed(
    db,
    bundleId,
    () =>
      queue.add(BUNDLE_JOB_NAMES.RESYNC_GIT, payload, {
        attempts: 1,
        removeOnComplete: 100,
        removeOnFail: 100,
      }),
    eq(schema.customBundles.updatedAt, syncingAt),
  );
  return c.json({ ok: true, bundleId });
});

/** Lazy file browser for a bundle's extracted/ tree. Returns flat
 *  `[{path,size}]` pairs (UI groups by `/`). Lists regular files only and skips `.git/`
 *  and `.DS_Store`, to keep git-sourced bundles small and avoid leaking pack contents.
 *  Lists at most FILES_LIST_CAP files; `truncated` says a file was left out, so the UI warns. */
export const FILES_LIST_CAP = 5000;

async function listExtractedFiles(
  anchor: string,
  rootRel: string,
): Promise<{
  files: Array<{ path: string; size: number }>;
  truncated: boolean;
  cap: number;
}> {
  const out: Array<{ path: string; size: number }> = [];
  let truncated = false;
  const walk = async (relDir: string, rel: string): Promise<void> => {
    // Lenient: a directory that cannot be listed — absent, unreadable, or a link standing where a
    // directory should be — contributes nothing, which is exactly what the `catch` here did.
    const entries = await readdirNoFollow(anchor, relDir);
    if (entries === null) return;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
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
      if (out.length >= FILES_LIST_CAP) {
        truncated = true;
        return;
      }
      out.push({ path: childRel, size: Number(info.stats.size) });
    }
  };
  await walk(rootRel, '');
  return { files: out, truncated, cap: FILES_LIST_CAP };
}

bundleRoutes.get('/:id/files', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);
  const anchor = bundleStorageRoot();
  const rootRel = bundleContentRel(userId, bundleId, row.storageRoot);
  // A stored root this route cannot place reads as an empty tree, the same answer a missing
  // directory already gave — the listing is a convenience, not a contract about what exists.
  if (rootRel === null) return c.json({ files: [], truncated: false, cap: FILES_LIST_CAP });
  const exists = await lstatNoFollow(anchor, rootRel);
  if (exists?.kind !== 'directory') {
    return c.json({ files: [], truncated: false, cap: FILES_LIST_CAP });
  }
  const result = await listExtractedFiles(anchor, rootRel);
  return c.json(result);
});

bundleRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const bundleId = c.req.param('id');
  const row = await loadBundle(userId, bundleId);

  // Wipe on-disk artefacts before dropping the row so a partial cleanup can
  // be retried by the user via the same DELETE.
  await removeNoFollow(bundleStorageRoot(), bundleRel(userId, bundleId), {
    recursive: true,
    repairPermissions: true,
  }).catch(() => {});

  await deleteBundleRow(row.id, row.repositoryId);
  return c.json({ ok: true });
});
