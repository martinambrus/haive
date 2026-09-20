import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { eq, and, asc, desc, gt, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  isPathContainmentError,
  lstatNoFollow,
  openFileNoFollow,
  readFileNoFollow,
  readTextNoFollow,
  readdirNoFollow,
  relUnder,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { containmentHttpError } from '../lib/fs-http.js';
import {
  ensureUploadsDir,
  truncateUploadFile,
  uploadFileRel,
  uploadFileRelOrThrow,
  uploadsRel,
  uploadsStorageRoot,
} from '../lib/uploads.js';
import { MAX_FILE_CONTENT_BYTES } from './tasks/_helpers.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createRepoRequestSchema,
  initRepoUploadRequestSchema,
  linkRepoRemoteRequestSchema,
  REPO_JOB_NAMES,
  updateRepoExclusionsRequestSchema,
  CLI_PROVIDER_LIST,
  HAIVE_DATA_DIR,
  normalizeContent,
  sha256Hex,
  unmanagedAgentsDir,
  type ArchiveFormat,
} from '@haive/shared';
import { buildScopeTree } from '@haive/shared/scope-tree';
import { parseScpLikeGitUrl } from '@haive/shared/schemas';
import {
  KB_DIR,
  LEARNINGS_DIR,
  stripManagedKnowledgeGlobs,
  trimGlobSlashes,
  tagManagedKnowledgeNodes,
} from '@haive/shared/knowledge-paths';
import { getDb } from '../db.js';
import { getRepoQueue, type RepoJobPayload } from '../queues.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import {
  cancelOpenTasksForRepo,
  collectInternalRagProjectNamesForRepo,
  enqueueCancelJob,
  enqueueRepoRagCleanupJob,
  enqueueRepoResourceCleanupJob,
} from '../lib/cancel-task.js';
import { validateLocalPath, pathExists, isGitRepository } from '../lib/filesystem.js';
import {
  LIVE_TASK_STATUSES,
  loadOnboardingTaskFacts,
  NO_ONBOARDING_TASKS,
  resolveOnboardingVerdict,
} from '../lib/onboarding-state.js';
import { createRepoArchiveStream } from '../lib/repo-archive.js';
import { inventoryDirsFromCatalog } from '../lib/tool-inventory.js';

function maxUploadBytes(): number {
  const raw = process.env.MAX_UPLOAD_BYTES;
  if (!raw) return 2 * 1024 * 1024 * 1024; // 2 GiB default
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2 * 1024 * 1024 * 1024;
  return parsed;
}

function detectArchiveFormat(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

function deriveRepoName(opts: {
  name?: string;
  remoteUrl?: string;
  localPath?: string;
  filename?: string;
}): string {
  if (opts.name?.trim()) return opts.name.trim();
  if (opts.remoteUrl) {
    // An scp-style address (`git@github.com:owner/repo.git`) is not a URL and
    // makes `new URL` throw, so it is parsed on its own terms first. Without
    // this the whole branch falls through and the repository is named from
    // nothing.
    const scp = parseScpLikeGitUrl(opts.remoteUrl);
    const last = scp
      ? scp.path.split('/').filter(Boolean).pop()
      : (() => {
          try {
            return new URL(opts.remoteUrl!).pathname.split('/').filter(Boolean).pop();
          } catch {
            return undefined;
          }
        })();
    if (last) return last.replace(/\.git$/, '');
  }
  if (opts.localPath) {
    const base = path.basename(opts.localPath);
    if (base) return base;
  }
  if (opts.filename) {
    return opts.filename.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '') || 'unnamed-repo';
  }
  return 'unnamed-repo';
}

// Top-level entries (first path segment, deduped + sorted) of a repo's file
// tree. Precomputed here for the list endpoint so its response carries only
// these — not the full, unbounded fileTree — and the web doesn't rescan the
// whole tree on every poll. Mirrors the exclusions validator's segmenting.
function deriveTopLevelPaths(fileTree: string[] | null): string[] {
  if (!fileTree) return [];
  const set = new Set<string>();
  for (const file of fileTree) {
    const head = file.split('/')[0];
    if (head) set.add(head);
  }
  return Array.from(set).sort();
}

export const repoRoutes = new Hono<AppEnv>();

repoRoutes.use('*', requireAuth);

repoRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.repositories.findMany({
    where: eq(schema.repositories.userId, userId),
    orderBy: [desc(schema.repositories.createdAt)],
  });

  // Per-repo task counts for the list badges. "Open" = non-terminal, matching
  // cancelOpenTasksForRepo. "Active" = open tasks not blocked on the user
  // (everything except waiting_user). Grouped once by (repo, status) and
  // folded in JS so the list stays a single round-trip plus this aggregate.
  const taskCounts = await db
    .select({
      repositoryId: schema.tasks.repositoryId,
      status: schema.tasks.status,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, userId),
        notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
        // Plan chats are excluded from the task listing, so counting them here
        // would badge a repository with work the list then refuses to show.
        ne(schema.tasks.type, 'plan_chat'),
      ),
    )
    .groupBy(schema.tasks.repositoryId, schema.tasks.status);

  // Onboarding-run facts for every row in one query: the markers on disk cannot tell a
  // finished run from a cancelled or a still-running one (see resolveOnboardingVerdict).
  const onboardingFacts = await loadOnboardingTaskFacts(
    db,
    userId,
    rows.map((r) => r.id),
  );

  const countsByRepo = new Map<string, { open: number; active: number }>();
  for (const row of taskCounts) {
    if (!row.repositoryId) continue;
    const entry = countsByRepo.get(row.repositoryId) ?? { open: 0, active: 0 };
    entry.open += row.n;
    if (row.status !== 'waiting_user') entry.active += row.n;
    countsByRepo.set(row.repositoryId, entry);
  }

  const repositories = await Promise.all(
    rows.map(async (repo) => {
      const counts = countsByRepo.get(repo.id) ?? { open: 0, active: 0 };
      // Strip the full fileTree (large, and this list is polled every 5s) and ship
      // only the top-level paths the list UI actually renders.
      const { fileTree, ...rest } = repo;
      // Onboarded flag drives the "not onboarded yet" badge + Onboard CTA on the
      // repos page. Only meaningful for ready repos (cloning/error have no tree);
      // the check is a few parallel stats per repo.
      const root = repo.storagePath ?? repo.localPath;
      const markers = repo.status === 'ready' && root ? await checkOnboardingMarkers(root) : null;
      const verdict = markers
        ? resolveOnboardingVerdict({
            missing: markers.missing,
            onboardedAt: repo.onboardedAt,
            facts: onboardingFacts.get(repo.id) ?? NO_ONBOARDING_TASKS,
          })
        : null;
      const onboarded = verdict?.onboarded ?? false;
      // An empty project: scaffolded, but with nothing to build a knowledge base
      // from. Offering to onboard it would offer an action that cannot
      // accomplish anything, and forcing the first task to be an onboarding run
      // (which is what `onboarded: false` does) blocks the user outright.
      const nothingToOnboard =
        markers !== null && !onboarded && root ? !(await hasOnboardableSource(root)) : false;
      return {
        ...rest,
        topLevelPaths: deriveTopLevelPaths(fileTree),
        openTaskCount: counts.open,
        activeTaskCount: counts.active,
        onboarded,
        nothingToOnboard,
        // Set while an onboarding run is in flight, so the card can link to it instead of
        // offering to start a second one.
        onboardingTaskId: verdict?.inProgressTaskId ?? null,
      };
    }),
  );

  return c.json({ repositories });
});

repoRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = createRepoRequestSchema.parse(await c.req.json());
  const db = getDb();

  if (body.credentialsId) {
    const cred = await db.query.repoCredentials.findFirst({
      where: and(
        eq(schema.repoCredentials.id, body.credentialsId),
        eq(schema.repoCredentials.userId, userId),
      ),
      columns: { id: true },
    });
    if (!cred) throw new HttpError(404, 'Credentials not found');
  }

  let localPath: string | null = null;
  if (body.source === 'local_path') {
    if (!body.localPath) throw new HttpError(400, 'localPath required');
    localPath = validateLocalPath(body.localPath);
    if (!(await pathExists(localPath))) throw new HttpError(404, 'Path does not exist');
    if (!(await isGitRepository(localPath))) {
      throw new HttpError(400, 'Path is not a git repository');
    }
  }

  const repoName = deriveRepoName({
    name: body.name,
    remoteUrl: body.remoteUrl,
    localPath: body.localPath,
  });

  const inserted = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: repoName,
      source: body.source,
      localPath,
      remoteUrl: body.remoteUrl ?? null,
      branch: body.branch ?? 'main',
      status: 'cloning',
      credentialsSecretId: body.credentialsId ?? null,
      writable: body.source === 'local_path' ? (body.writable ?? false) : false,
    })
    .returning();

  const repo = inserted[0]!;
  const queue = getRepoQueue();
  const payload: RepoJobPayload = {
    repositoryId: repo.id,
    userId,
    source: body.source,
    ...(localPath ? { localPath } : {}),
    ...(body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
    ...(body.branch ? { branch: body.branch } : {}),
    ...(body.credentialsId ? { credentialsId: body.credentialsId } : {}),
  };
  const jobName =
    body.source === 'blank'
      ? REPO_JOB_NAMES.INIT
      : body.source === 'local_path'
        ? body.writable
          ? REPO_JOB_NAMES.COPY
          : REPO_JOB_NAMES.SCAN
        : REPO_JOB_NAMES.CLONE;
  await queue.add(jobName, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ repository: repo }, 201);
});

repoRoutes.post('/upload', async (c) => {
  const userId = c.get('userId');
  const db = getDb();

  const form = await c.req.formData();
  const nameField = form.get('name');
  const branchField = form.get('branch');
  const archiveField = form.get('archive');

  if (nameField !== null && typeof nameField !== 'string') {
    throw new HttpError(400, 'name must be a string');
  }
  if (typeof nameField === 'string' && nameField.length > 255) {
    throw new HttpError(400, 'name must be at most 255 characters');
  }
  if (!(archiveField instanceof File)) {
    throw new HttpError(400, 'archive file is required');
  }
  if (archiveField.size === 0) {
    throw new HttpError(400, 'archive is empty');
  }
  if (archiveField.size > maxUploadBytes()) {
    throw new HttpError(413, `archive exceeds ${maxUploadBytes()} bytes limit`);
  }
  const format = detectArchiveFormat(archiveField.name);
  if (!format) {
    throw new HttpError(400, 'unsupported archive format (allowed: .zip, .tar, .tar.gz, .tgz)');
  }
  const branch = typeof branchField === 'string' && branchField.length > 0 ? branchField : 'main';

  const uploadRepoName = deriveRepoName({
    name: nameField ?? undefined,
    filename: archiveField.name,
  });

  const inserted = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: uploadRepoName,
      source: 'upload',
      localPath: null,
      remoteUrl: null,
      branch,
      status: 'cloning',
      credentialsSecretId: null,
    })
    .returning();
  const repo = inserted[0]!;

  const storageRoot = await ensureUploadsDir(userId);
  const ext = format === 'tar.gz' ? 'tar.gz' : format;
  const archiveRel = `${uploadsRel(userId)}/${repo.id}.${ext}`;
  const archivePath = path.join(storageRoot, archiveRel);

  let fh: FileHandle | null = null;
  try {
    // Created exclusively and streamed through that one descriptor, so the bytes cannot land
    // anywhere but the inode this route made. `open(path, 'w')` truncated whatever stood at the
    // name and followed a link there; the name embeds a fresh row id, so EEXIST is a collision to
    // fail on rather than overwrite.
    fh = await openFileNoFollow(storageRoot, archiveRel, 'create-exclusive', { fileMode: 0o644 });
    const body = archiveField.stream() as unknown as ReadableStream<Uint8Array>;
    const nodeStream = Readable.fromWeb(body as never);
    let total = 0;
    nodeStream.on('data', (buf: Buffer) => {
      total += buf.length;
    });
    await pipeline(nodeStream, fh.createWriteStream());
    // Counted off the stream rather than stat'ed back off the path. The multipart `size` checked
    // above is the client's claim, which is what this second check has always been guarding.
    if (total > maxUploadBytes()) {
      throw new HttpError(413, `archive exceeds ${maxUploadBytes()} bytes limit`);
    }
  } catch (err) {
    if (fh) {
      // The stream closes the handle at `finish` and `pipeline` destroys it on failure; a close
      // after either is a no-op, and this also covers a stream that never started.
      await fh.close().catch(() => {});
      await removeNoFollow(storageRoot, archiveRel).catch(() => {});
    }
    await db.delete(schema.repositories).where(eq(schema.repositories.id, repo.id));
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `failed to write archive: ${(err as Error).message}`);
  }

  const queue = getRepoQueue();
  const payload: RepoJobPayload = {
    repositoryId: repo.id,
    userId,
    source: 'upload',
    branch,
    archivePath,
    archiveFormat: format,
  };
  // One attempt only: a bad archive will fail the same way on retry, and the
  // worker deletes the archive on success, so retrying would run against a
  // missing file and mask the real error.
  await queue.add(REPO_JOB_NAMES.EXTRACT, payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ repository: repo }, 201);
});

function sessionFromRow(row: typeof schema.repoUploads.$inferSelect) {
  return {
    id: row.id,
    filename: row.filename,
    archiveFormat: row.archiveFormat as ArchiveFormat,
    totalSize: Number(row.totalSize),
    bytesReceived: Number(row.bytesReceived),
    chunkSize: row.chunkSize,
    status: row.status as 'uploading' | 'complete' | 'cancelled',
  };
}

async function loadUploadSession(userId: string, uploadId: string) {
  const db = getDb();
  const row = await db.query.repoUploads.findFirst({
    where: and(eq(schema.repoUploads.id, uploadId), eq(schema.repoUploads.userId, userId)),
  });
  if (!row) throw new HttpError(404, 'upload session not found');
  return row;
}

repoRoutes.post('/upload/init', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const body = initRepoUploadRequestSchema.parse(await c.req.json());

  if (body.totalSize > maxUploadBytes()) {
    throw new HttpError(413, `archive exceeds ${maxUploadBytes()} bytes limit`);
  }
  const format = detectArchiveFormat(body.filename);
  if (!format) {
    throw new HttpError(400, 'unsupported archive format (allowed: .zip, .tar, .tar.gz, .tgz)');
  }

  const storageRoot = await ensureUploadsDir(userId);

  const inserted = await db
    .insert(schema.repoUploads)
    .values({
      userId,
      name: body.name?.trim() || null,
      branch: body.branch?.trim() || 'main',
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

  const ext = format === 'tar.gz' ? 'tar.gz' : format;
  const archiveRel = `${uploadsRel(userId)}/${session.id}.${ext}.partial`;
  const archivePath = path.join(storageRoot, archiveRel);
  // `open(path, 'w')` truncated whatever stood at the name, a link included. The name embeds a
  // fresh session id, so exclusive creation is the same outcome for every legitimate call.
  const fh = await openFileNoFollow(storageRoot, archiveRel, 'create-exclusive', {
    fileMode: 0o644,
  });
  await fh.close();

  const updated = await db
    .update(schema.repoUploads)
    .set({ archivePath, updatedAt: new Date() })
    .where(eq(schema.repoUploads.id, session.id))
    .returning();

  return c.json({ session: sessionFromRow(updated[0]!) }, 201);
});

repoRoutes.get('/upload/:id', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const row = await loadUploadSession(userId, uploadId);
  return c.json({ session: sessionFromRow(row) });
});

repoRoutes.put('/upload/:id/chunk', async (c) => {
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

  const claim = await db
    .update(schema.repoUploads)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(schema.repoUploads.id, row.id),
        eq(schema.repoUploads.bytesReceived, start),
        eq(schema.repoUploads.status, 'uploading'),
      ),
    )
    .returning({ id: schema.repoUploads.id });
  if (claim.length === 0) {
    throw new HttpError(409, 'chunk races another writer');
  }

  const rawBody = c.req.raw.body;
  if (!rawBody) throw new HttpError(400, 'request body is empty');
  const storageRoot = uploadsStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Upload session archive');
  const nodeStream = Readable.fromWeb(rawBody as never);
  // Written at the session's OWN offset instead of with `flags: 'a'`: the offset is the fact the
  // row already tracks and the claim above just verified, where appending trusted the file's
  // current length. MEASURED on node v26.7.0, `createWriteStream({ start })` positions the write.
  const fh = await openFileNoFollow(storageRoot, archiveRel, 'read-write', { strict: true }).catch(
    (err: unknown) => containmentHttpError(err, 'Upload archive is outside the uploads directory'),
  );
  if (!fh) throw new HttpError(409, 'Upload archive is missing on disk');
  let written = 0;
  nodeStream.on('data', (buf: Buffer) => {
    written += buf.length;
  });
  try {
    await pipeline(nodeStream, fh.createWriteStream({ start }));
  } catch (err) {
    await truncateUploadFile(storageRoot, archiveRel, Number(row.bytesReceived));
    throw new HttpError(500, `chunk write failed: ${(err as Error).message}`);
  }
  if (written !== expectedLen) {
    await truncateUploadFile(storageRoot, archiveRel, Number(row.bytesReceived));
    throw new HttpError(400, `chunk body length ${written} != expected ${expectedLen}`);
  }

  const updated = await db
    .update(schema.repoUploads)
    .set({ bytesReceived: end + 1, updatedAt: new Date() })
    .where(eq(schema.repoUploads.id, row.id))
    .returning();

  return c.json({ session: sessionFromRow(updated[0]!) });
});

repoRoutes.post('/upload/:id/complete', async (c) => {
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

  const storageRoot = uploadsStorageRoot();
  const archiveRel = uploadFileRelOrThrow(userId, row.archivePath, 'Upload session archive');
  // A link at that name now fails this check rather than reporting its target's size.
  const onDisk = await lstatNoFollow(storageRoot, archiveRel);
  if (!onDisk || onDisk.kind !== 'file' || onDisk.stats.size !== Number(row.totalSize)) {
    throw new HttpError(409, 'archive size mismatch on disk');
  }

  const finalRel = archiveRel.replace(/\.partial$/, '');
  if (finalRel === archiveRel) {
    throw new HttpError(500, 'archive path missing .partial suffix');
  }
  const finalPath = path.join(storageRoot, finalRel);
  await renameNoFollow(storageRoot, archiveRel, finalRel);

  const repoName = deriveRepoName({
    name: row.name ?? undefined,
    filename: row.filename,
  });
  const branch = row.branch && row.branch.length > 0 ? row.branch : 'main';

  const inserted = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: repoName,
      source: 'upload',
      localPath: null,
      remoteUrl: null,
      branch,
      status: 'cloning',
      credentialsSecretId: null,
    })
    .returning();
  const repo = inserted[0]!;

  const queue = getRepoQueue();
  const payload: RepoJobPayload = {
    repositoryId: repo.id,
    userId,
    source: 'upload',
    branch,
    archivePath: finalPath,
    archiveFormat: row.archiveFormat as ArchiveFormat,
  };
  // One attempt only: a bad archive will fail the same way on retry, and the
  // worker deletes the archive on success, so retrying would run against a
  // missing file and mask the real error.
  await queue.add(REPO_JOB_NAMES.EXTRACT, payload, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  await db
    .update(schema.repoUploads)
    .set({ status: 'complete', archivePath: finalPath, updatedAt: new Date() })
    .where(eq(schema.repoUploads.id, row.id));

  return c.json({ repository: repo, session: { id: row.id, status: 'complete' } }, 201);
});

repoRoutes.delete('/upload/:id', async (c) => {
  const userId = c.get('userId');
  const uploadId = c.req.param('id');
  const db = getDb();

  const row = await loadUploadSession(userId, uploadId);
  // Cancelling must succeed whatever the row's path looks like, so a refused shape only skips the
  // unlink: the session is still cancelled, and a leftover partial is the sweeper's problem rather
  // than a reason to refuse the cancel.
  try {
    const archiveRel = uploadFileRel(userId, row.archivePath);
    if (archiveRel) await removeNoFollow(uploadsStorageRoot(), archiveRel);
  } catch {
    // absent, refused, or a path this api never wrote
  }
  await db
    .update(schema.repoUploads)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(schema.repoUploads.id, row.id));

  return c.json({ ok: true });
});

repoRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  return c.json({ repository: repo });
});

// Live deep+hidden directory tree for the repos-page scope editor. Walked on
// demand off the shared haive_repos volume (NOT the flat, non-hidden fileTree
// column, which cannot represent nested/hidden dirs). Returns the nested tree
// plus the current deny list so the editor can pre-tick excluded subtrees.
repoRoutes.get('/:id/scope-tree', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: {
      id: true,
      status: true,
      storagePath: true,
      localPath: true,
      scopeExcludeGlobs: true,
    },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  const root = repo.storagePath ?? repo.localPath;
  if (!root) throw new HttpError(409, 'Repository has no on-disk path yet');
  const tree = tagManagedKnowledgeNodes(await buildScopeTree(root));
  return c.json({ tree, scopeExcludeGlobs: repo.scopeExcludeGlobs ?? [] });
});

/** One text file from the repository, for the plan canvas's code-link preview.
 *  Repo-scoped rather than task-scoped (`/tasks/:id/files`): a plan code link
 *  names a path in the repository and exists whether or not any task is open on
 *  it. Read-only, capped, and refuses anything outside the repo root. */
repoRoutes.get('/:id/file', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const requested = c.req.query('path');
  if (!requested) throw new HttpError(400, 'Missing path query parameter');

  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { id: true, storagePath: true, localPath: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  const root = repo.storagePath ?? repo.localPath;
  if (!root) throw new HttpError(409, 'Repository has no on-disk path yet');

  // `relUnder` resolves THEN contains — `path.resolve` collapses `..`, so containment is judged
  // on where the read would land — and hands the walk a rel whose components it never follows.
  let rel: string;
  try {
    rel = relUnder(root, path.resolve(root, requested));
  } catch {
    throw new HttpError(403, 'Path is outside the repository');
  }

  const read = await readFileNoFollow(root, rel, {
    maxBytes: MAX_FILE_CONTENT_BYTES,
    strict: true,
  }).catch((err: unknown) => containmentHttpError(err, 'Path is outside the repository'));
  if (read === null) throw new HttpError(404, 'File not found');

  // A NUL in the first block is the usual "this is not text" tell; returning
  // it as a string would render as mojibake in the preview.
  if (read.data.includes(0)) {
    return c.json({ path: rel, size: read.size, binary: true, truncated: false, content: null });
  }
  return c.json({
    path: rel,
    size: read.size,
    binary: false,
    truncated: read.truncated,
    content: read.data.toString('utf8'),
  });
});

repoRoutes.patch('/:id/exclusions', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = updateRepoExclusionsRequestSchema.parse(await c.req.json());
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  // Normalize (strip surrounding slashes) + drop empties. Nested globs are
  // allowed and NOT validated against the tree: the deny list tolerates a glob
  // that matches nothing (isDeniedPath simply won't fire), matching how the
  // onboarding scope-picker (06_7) persists its frontier.
  //
  // The managed knowledge dirs are then dropped unconditionally: they must stay
  // readable/indexable however the editor (or a hand-rolled request) ticks the
  // tree. This is the server-side backstop for the same strip the picker steps
  // and the repos page apply.
  const scopeExcludeGlobs = stripManagedKnowledgeGlobs(
    Array.from(new Set(body.scopeExcludeGlobs.map(trimGlobSlashes).filter((p) => p.length > 0))),
  ).sort();

  const updated = await db
    .update(schema.repositories)
    .set({ scopeExcludeGlobs, updatedAt: new Date() })
    .where(eq(schema.repositories.id, id))
    .returning();
  const { fileTree: _drop, ...rest } = updated[0]!;
  return c.json({ repository: rest });
});

const ONBOARDING_MARKERS = [
  KB_DIR,
  '.claude/agents',
  '.claude/skills',
  '.claude/workflow-config.json',
];

/**
 * Top-level entries Haive itself puts in a repository, so a tree holding only
 * these has no source to mine.
 *
 * The per-CLI parts are DERIVED from `CLI_PROVIDER_LIST` rather than listed:
 * the blank-repo scaffold emits one agents directory per enabled provider, and
 * a hardcoded list silently stops matching the day a CLI is added — the repo
 * would then look like it had source and go back to demanding onboarding.
 * MEASURED on a seeded repo: `.agents`, `.codex` and `.grok` all appeared
 * beside `.claude`, and an earlier hardcoded set knew only the last two.
 *
 * Built on first use, not at module load: it reads ONBOARDING_RULES_FILES,
 * which is declared further down this file, and a module-level const reading it
 * eagerly would hit the temporal dead zone on import.
 */
let scaffoldEntries: Set<string> | null = null;
function getScaffoldEntries(): Set<string> {
  scaffoldEntries ??= new Set<string>([
    '.git',
    HAIVE_DATA_DIR,
    'README.md',
    '.ripgreprc',
    ...ONBOARDING_RULES_FILES,
    // Just the first segment: `.claude/agents` exists in the root as `.claude`,
    // which is what a readdir actually returns.
    ...CLI_PROVIDER_LIST.flatMap((m) =>
      m.projectAgentsDir ? [m.projectAgentsDir.split('/')[0]!] : [],
    ),
  ]);
  return scaffoldEntries;
}

/**
 * Whether the repository holds anything an onboarding run could learn from.
 *
 * Read from DISK rather than `repositories.file_tree`: that column is written
 * once by persistDetection at clone/init time, so a blank repo that later grows
 * would still describe an empty project and the offer would never come back.
 *
 * A root that cannot be read counts as HAVING source. The offer standing when it
 * should not is a wasted click; withdrawing it when the user does have code to
 * onboard would hide the feature outright.
 */
export async function hasOnboardableSource(root: string): Promise<boolean> {
  // Lenient rather than strict, because `null` covers an absent root, an unreadable one and a
  // refused one alike — and all three mean the same thing here, per the note above.
  const entries = await readdirNoFollow(root, '');
  if (entries === null) return true;
  const scaffold = getScaffoldEntries();
  return entries.some((e) => !scaffold.has(e.name));
}

/** Which ONBOARDING_MARKERS exist on disk. NOT the onboarded verdict on its own — every
 *  one of them is written by 07-generate-files, the 8th of 27 onboarding steps, so a
 *  cancelled run and a live one leave exactly the same files; `resolveOnboardingVerdict`
 *  combines this with the repo's onboarding task history. Marker checks run in parallel;
 *  results keep marker order so the detail endpoint's present/missing lists stay stable. */
export async function checkOnboardingMarkers(
  root: string,
): Promise<{ present: string[]; missing: string[] }> {
  const results = await Promise.all(
    ONBOARDING_MARKERS.map(async (rel) => {
      // `pathExists` is `stat`-based: it followed a link and read a dangling one as absent, so a
      // linked `.claude/agents` counted as installed while the definitions it named lived outside
      // the tree — and these counts are what the onboarded verdict and `mark-onboarded` rest on.
      const info = await lstatNoFollow(root, rel);
      return [rel, info !== null && (info.kind === 'file' || info.kind === 'directory')] as const;
    }),
  );
  return {
    present: results.filter(([, ok]) => ok).map(([rel]) => rel),
    missing: results.filter(([, ok]) => !ok).map(([rel]) => rel),
  };
}

/** Every directory onboarding fills with agents or skills, plus Haive's own knowledge dirs.
 *
 *  DERIVED from the provider catalog for the reason `getScaffoldEntries` gives: a hardcoded list
 *  silently stops matching the day a CLI is added. This one HAD — it was `['.claude', KB_DIR,
 *  LEARNINGS_DIR]` from when `.claude` was the only CLI directory, so a reset left the previous
 *  run's agents and skills on disk for every other CLI and the next run wrote on top of them.
 *
 *  Exact directories, never their first segment: `.codex` and `.gemini` also hold files Haive
 *  never wrote. `inventoryDirsFromCatalog` already excludes the `-legacy` quarantine siblings,
 *  which is what keeps the user's own agent definitions (07 MOVES them there) out of a reset.
 *
 *  The catalog is the CANDIDATE set, never the removal set. 07 writes agents to the ENABLED
 *  providers' dirs only (`agentTargetsByDir`, built from `providerRows.filter(p => p.enabled)`)
 *  and `resolveSkillTargetDirs` does the same for skills, so on a repo where only claude is
 *  enabled a `.codex/agents` or `.grok/skills` holds the user's own definitions and nothing of
 *  ours — and this action is irreversible. `haiveDirs` is what the caller could PROVE, and a
 *  candidate outside it is reported rather than removed. */
function onboardingResetDirs(haiveDirs: ReadonlySet<string>): {
  remove: string[];
  candidates: string[];
} {
  const remove = new Set<string>([KB_DIR, LEARNINGS_DIR]);
  const candidates: string[] = [];
  for (const entry of inventoryDirsFromCatalog()) {
    if (haiveDirs.has(entry.dir)) remove.add(entry.dir);
    else candidates.push(entry.dir);
  }
  return { remove: [...remove], candidates };
}

/** The two onboarding steps that RECORD what they wrote. 07's apply output carries `wroteFiles`
 *  — the paths it actually wrote, skipped ones excluded — and 09_5's carries
 *  `written[].mirroredDirs` plus each skill's id. */
const AGENT_TARGETS_STEP_ID = '07-generate-files';
const SKILL_MIRROR_STEP_ID = '09_5-skill-generation';
/** `09_5b-skill-repair` CLEARS and rebuilds a failing skill's tree in the repo root, so 09_5's
 *  record of that skill is STALE — the rebuild may produce different sub-skill slugs, and the
 *  rewritten files would be quarantined as foreign. Its own shape is `repaired` (skill IDS)
 *  with the target dirs in its DETECT payload, and it records no slugs, so it retires the stale
 *  claims and re-claims the skill without naming what is inside `sub-skills`.
 *
 *  `11d-skill-sync` is deliberately NOT here. It mirrors skills during a WORKFLOW run, but it
 *  writes into that task's WORKTREE (`resolveWorktree`), so its record does not describe the
 *  repository root unless the work was merged — and `12-worktree-cleanup` permits `keep` and
 *  `remove_only`, so even a completed task does not prove it was. Claiming from it could delete
 *  an untouched ROOT copy of a skill it only ever changed in a worktree. The cost of leaving it
 *  out is that a skill a workflow generated is quarantined rather than removed: clutter, in the
 *  direction that loses nothing. */
const SKILL_REPAIR_STEP_ID = '09_5b-skill-repair';
const PROVENANCE_STEP_IDS = [AGENT_TARGETS_STEP_ID, SKILL_MIRROR_STEP_ID, SKILL_REPAIR_STEP_ID];

/**
 * The step rows whose records may be read as provenance for this repository.
 *
 * Two predicates, and both are load-bearing. `status = 'done'` is the proof that APPLY ran: 07
 * persists its detect payload before the form is even shown, so a run cancelled or failed while
 * parked there names directories nothing was written to. `epoch` is
 * `repositories.onboarding_reset_at`: a reset supersedes artifact rows but CANNOT touch
 * `task_steps`, so a pre-reset run's `wroteFiles` still names paths it wrote and the reset then
 * DELETED — and if the user recreates one of those names by hand and a later run SKIPS it under
 * `overwrite=false`, that stale record claims their new file. Reading only the NEWEST run does
 * not fix it: with no re-onboarding since, the newest run IS the pre-reset one. A null epoch is
 * every repo never reset, which reads every run exactly as it always did.
 *
 * Exported for `onboarding-reset-provenance-smoke`, which is the only thing that can exercise
 * the predicates — they are SQL, and the unit tests run against no database.
 */
export async function loadProvenanceSteps(
  db: ReturnType<typeof getDb>,
  repositoryId: string,
  epoch: Date | null,
): Promise<Array<{ stepId: string; detectOutput: unknown; output: unknown }>> {
  return (
    db
      .select({
        stepId: schema.taskSteps.stepId,
        detectOutput: schema.taskSteps.detectOutput,
        output: schema.taskSteps.output,
      })
      .from(schema.taskSteps)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          inArray(schema.taskSteps.stepId, PROVENANCE_STEP_IDS),
          eq(schema.taskSteps.status, 'done'),
          // The STEP's own clock, never the task's creation time. A failed run — or a single
          // step — can be retried after a reset, and the task keeps its original `created_at`,
          // so keying on that excluded the rewritten 07/09_5 output for good while its files sat
          // on disk. `ended_at` is when this step actually wrote. A `done` step missing it is
          // excluded, which quarantines its files rather than removing them: the safe direction.
          ...(epoch === null ? [] : [gt(schema.taskSteps.endedAt, epoch)]),
        ),
      )
      // OLDEST first, because a later run can RETIRE an earlier claim: `11d-skill-sync` deletes
      // a skill whose id 09_5 once wrote, and replaying that in the wrong order leaves the dead
      // claim standing — which would delete a skill of the same name the user wrote afterwards.
      // Ordered by the same execution clock the epoch filters on, so a retried step replays in
      // the position it actually ran rather than where its task began.
      .orderBy(asc(schema.taskSteps.endedAt), asc(schema.taskSteps.createdAt))
  );
}

/**
 * Which catalog agents/skills directories Haive is KNOWN to have written to in this repository.
 *
 * From the RUNS, never from the currently enabled providers: enablement is mutable global state
 * that says nothing about what this repo's onboarding did, so a CLI enabled afterwards would
 * make its directory eligible for a removal no run here ever wrote to, while one disabled since
 * would strand the skills it did write. The live artifact rows are the third source and the only
 * per-file one; they also cover a repo whose step payloads predate these fields.
 *
 * Every claim is checked against the catalog, so a payload naming something else contributes
 * nothing — these are stored JSON written by an older Haive, not a typed contract.
 */
export function collectWrittenCliContent(
  steps: ReadonlyArray<{ stepId: string; detectOutput?: unknown; output: unknown }>,
  artifacts: ReadonlyArray<{ diskPath: string }>,
): { dirs: Set<string>; entries: Set<string> } {
  const catalog = inventoryDirsFromCatalog();
  const byDir = new Map(catalog.map((entry) => [entry.dir, entry]));
  const dirs = new Set<string>();
  const entries = new Set<string>();
  const claimDir = (value: unknown): string | null => {
    if (typeof value !== 'string' || !byDir.has(value)) return null;
    dirs.add(value);
    return value;
  };
  /** Claim the entry of `dir` that contains `rel`, so a path deeper than one level (a skill's
   *  `<dir>/<id>/SKILL.md`) claims the directory it lives in rather than nothing. */
  const claimPath = (value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const spec of catalog) {
      if (!value.startsWith(`${spec.dir}/`)) continue;
      dirs.add(spec.dir);
      const head = value.slice(spec.dir.length + 1).split('/')[0];
      if (head) entries.add(`${spec.dir}/${head}`);
    }
    // `.claude` is Haive's own directory but not a catalog one, and its SWEEP removes only what
    // is claimed here — `workflow-config.json`, the slash commands, the Drupal LSP files. What
    // is left is the user's and stays put.
    //
    // The WHOLE path, never its head segment: `.claude/plugins/drupal-php-lsp/<file>` collapsed
    // to `.claude/plugins` claims a directory that also holds plugins the user installed, and
    // the sweep then removes all of them. The sweep walks instead, on `hasDeeperClaims`.
    if (value.startsWith(`${ONBOARDING_SWEEP_DIR}/`)) entries.add(value);
  };

  for (const step of steps) {
    if (step.stepId === AGENT_TARGETS_STEP_ID) {
      // What 07 actually WROTE, never its target list and never the manifest's agent ids. With
      // the default `overwrite=false`, `writeIfAllowed` SKIPS a pre-existing file — so a user's
      // own `code-reviewer.toml` is one a successful apply deliberately left alone, and claiming
      // it by id would exempt it from the quarantine and delete it with the directory. This also
      // covers the fallback write to `.claude/agents` when no provider has an agents dir (amp
      // alone, where `agentTargets` is empty) and the LLM-discovered custom agents, which have
      // no manifest id at all.
      const wrote = (step.output as { wroteFiles?: unknown } | null)?.wroteFiles;
      if (Array.isArray(wrote)) for (const rel of wrote) claimPath(rel);
    } else if (step.stepId === SKILL_REPAIR_STEP_ID) {
      // 09_5b has its OWN shape — `repaired`, skill IDS, with the target dirs in its DETECT
      // payload — and it CLEARS the skill's tree before rewriting it, so 09_5's slug record for
      // that skill is stale and has to be RETIRED. That is why the rows are replayed oldest
      // first. It records no slugs of its own, so `sub-skills` is deliberately NOT claimed: a
      // directory claimed with nothing named inside it reads as wholly ours, and a file the
      // user put there would be deleted rather than moved aside.
      const repairDirs = (step.detectOutput as { skillTargetDirs?: unknown } | null)
        ?.skillTargetDirs;
      if (!Array.isArray(repairDirs)) continue;
      const out = step.output as { repaired?: unknown; repairedSubSkillSlugs?: unknown } | null;
      const repaired = out?.repaired;
      // A repair pass that landed NOTHING wrote nothing — every skill it attempted is in
      // `stillFailing`. Scoping its target dirs anyway put directories Haive never touched in
      // reach of the reset, which would move the user's own skills into `-legacy`.
      if (!Array.isArray(repaired) || repaired.length === 0) continue;
      const repairedSlugs = (out?.repairedSubSkillSlugs ?? null) as Record<string, unknown> | null;
      for (const value of repairDirs) {
        const dir = claimDir(value);
        if (dir === null) continue;
        for (const skillId of repaired) {
          if (typeof skillId !== 'string') continue;
          const skillDir = `${dir}/${skillId}`;
          for (const claimed of [...entries]) {
            if (claimed === skillDir || claimed.startsWith(`${skillDir}/`)) entries.delete(claimed);
          }
          entries.add(skillDir);
          entries.add(`${skillDir}/SKILL.md`);
          // Same rule as 09_5: `sub-skills` is claimed ONLY when the slugs in it were named, or
          // the directory reads as wholly ours and a file the user put there is deleted rather
          // than moved aside. An output written before the field existed has it quarantined.
          const slugs = repairedSlugs?.[skillId];
          if (Array.isArray(slugs) && slugs.length > 0) {
            entries.add(`${skillDir}/sub-skills`);
            for (const slug of slugs) {
              if (typeof slug === 'string') entries.add(`${skillDir}/sub-skills/${slug}.md`);
            }
          }
        }
        // It rebuilds the index from the on-disk set whenever it repaired anything.
        if (repaired.length > 0) entries.add(`${dir}/README.md`);
      }
    } else if (step.stepId === SKILL_MIRROR_STEP_ID) {
      const written = (step.output as { written?: unknown } | null)?.written;
      if (!Array.isArray(written)) continue;
      for (const skill of written) {
        const row = skill as {
          id?: unknown;
          mirroredDirs?: unknown;
          subSkillSlugs?: unknown;
        } | null;
        if (!Array.isArray(row?.mirroredDirs)) continue;
        for (const value of row.mirroredDirs) {
          const dir = claimDir(value);
          if (dir === null) continue;
          // A generated skill is a DIRECTORY, so the entry is the id — and what 09_5 puts INSIDE
          // it is claimed file by file, which is what stops the sweep treating the whole
          // directory as ours: a `NOTES.md` a person left beside `SKILL.md` is theirs, and a
          // claimed directory with deeper claims is walked rather than removed whole. The
          // sub-skill SLUGS are named for the same reason one level further down; an output
          // written before they were recorded claims the directory alone, so its contents are
          // moved aside rather than deleted.
          if (typeof row.id === 'string') {
            const skillDir = `${dir}/${row.id}`;
            entries.add(skillDir);
            entries.add(`${skillDir}/SKILL.md`);
            // `sub-skills` is claimed ONLY when the slugs inside it were recorded. A directory
            // claimed with nothing named inside reads as wholly ours — `hasDeeperClaims` is
            // false — so a file the user put there would be deleted rather than moved aside.
            // An output written before the slugs existed therefore has it quarantined whole.
            if (Array.isArray(row.subSkillSlugs) && row.subSkillSlugs.length > 0) {
              entries.add(`${skillDir}/sub-skills`);
              for (const slug of row.subSkillSlugs) {
                if (typeof slug === 'string') entries.add(`${skillDir}/sub-skills/${slug}.md`);
              }
            }
          }
          // The index beside them is rebuilt from the cumulative set on every pass and is Haive's
          // too — unclaimed, it would be quarantined out of the directory it describes.
          entries.add(`${dir}/README.md`);
        }
      }
    }
  }

  // The live rows put a directory IN SCOPE — an upgrade writes through them, and they are all a
  // repo whose step payloads predate these fields has — but they never claim an entry on their
  // own. `recordOnboardingArtifacts` inserts one row per manifest RENDERING without consulting
  // `wroteFiles`, so a pre-existing user file that apply SKIPPED has a row too, carrying the
  // hash of what Haive would have written rather than what is there. That is why the entry-level
  // claim for a row is the hash check in `resetOnboardingArtifacts`, not this.
  for (const row of artifacts) {
    for (const spec of catalog) {
      if (row.diskPath.startsWith(`${spec.dir}/`)) dirs.add(spec.dir);
    }
  }
  return { dirs, entries };
}

/** `.haive/` is the git-excluded dir; only this one file in it is onboarding's. */
const INSTALL_MANIFEST_PATH = '.haive/install.json';
const ONBOARDING_RESET_FILES = ['.ripgreprc', INSTALL_MANIFEST_PATH];

/** The one directory swept entry by entry rather than removed whole: `.claude` holds Haive's
 *  workflow config, commands and review files beside things Haive must not take back. */
const ONBOARDING_SWEEP_DIR = '.claude';

/** rtk's two settings files. Haive writes them, but `writeIfAllowed` SKIPS a file that already
 *  exists (`07-generate-files.ts:789`), so the one on disk may be the user's own — a stored
 *  `written_hash` is the only evidence either way, so provenance decides per file. */
const ONBOARDING_SETTINGS_FILES = ['.claude/settings.json', '.gemini/settings.json'];

/** Kept by a sweep although it sits in a directory Haive otherwise owns: `mcp_settings.json` is
 *  created once and never rewritten (`isUserOwnedAfterWrite`), and a `*-legacy` directory holds
 *  the agent definitions the user already had, which 07 moved aside rather than deleting. */
function keptSweepReason(name: string): string | null {
  if (name === 'mcp_settings.json') return 'user-owned after its first write';
  if (name.endsWith('-legacy')) return 'quarantined agents you had before onboarding';
  return null;
}

const ONBOARDING_RULES_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const HAIVE_MARKER_PAIRS: Array<[string, string]> = [
  ['<!-- haive:project-info -->', '<!-- /haive:project-info -->'],
  ['<!-- haive:cli-rules -->', '<!-- /haive:cli-rules -->'],
];

/** Remove Haive's own marker regions from one rules file, reporting what that did to it.
 *
 *  `null` means there is nothing here, which replaces the caller's `pathExists` probe: that probe
 *  FOLLOWED a link, so a rules file pointing out of the tree had its TARGET rewritten by the
 *  reset, and it read a dangling link as absent. Strict, so a link THROWS and the caller records
 *  it per item — an in-tree target is still handled on its own iteration of the same loop. */
export async function stripHaiveContent(
  root: string,
  rel: string,
): Promise<{ changed: boolean; deleted: boolean } | null> {
  const content = await readTextNoFollow(root, rel, { strict: true });
  if (content === null) return null;
  let next = content;
  for (const [start, end] of HAIVE_MARKER_PAIRS) {
    while (true) {
      const s = next.indexOf(start);
      if (s < 0) break;
      const e = next.indexOf(end, s);
      if (e < 0) break;
      next = next.slice(0, s) + next.slice(e + end.length);
    }
  }
  next = next.replace(/^@AGENTS\.md\s*$/gm, '');
  const cleaned = next.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned === content.trim()) return { changed: false, deleted: false };
  if (cleaned.length === 0) {
    await removeNoFollow(root, rel);
    return { changed: true, deleted: true };
  }
  await writeFileNoFollow(root, rel, cleaned + '\n');
  return { changed: true, deleted: false };
}

export interface OnboardingResetOutcome {
  removed: string[];
  cleaned: string[];
  /** What the reset left alone, and why. Kept files and refused links share this channel. */
  skipped: Array<{ path: string; reason: string }>;
  /** Moved to the `<dir>-legacy` sibling instead of being deleted with the directory. */
  quarantined: Array<{ from: string; to: string }>;
}

/** What the caller could establish about what Haive wrote here. Every field is evidence, not
 *  policy: the reset removes what it covers and keeps what it does not. */
export interface OnboardingResetProvenance {
  /** `written_hash` of every LIVE `onboarding_artifacts` row, by disk path. */
  writtenHashes: ReadonlyMap<string, string>;
  /** Catalog agents/skills directories Haive wrote to for this repository. */
  haiveDirs: ReadonlySet<string>;
  /** `<dir>/<name>` entries inside those directories that Haive wrote. Anything else in one is
   *  the user's — the quarantine default is OFF (`07-generate-files.ts:762`), so their own
   *  definitions legitimately sit beside ours. */
  haiveEntries: ReadonlySet<string>;
}

/**
 * Take back what onboarding wrote to a repository, and nothing else.
 *
 * `writtenHashes` is the only evidence that a file Haive CAN write is one it DID write, and it
 * decides the settings files (see `ONBOARDING_SETTINGS_FILES`). `haiveDirs` decides which
 * per-CLI directories are in scope at all, and `haiveEntries` which of their contents are ours;
 * an entry in neither is MOVED to the `-legacy` sibling rather than deleted with the directory.
 * Everything else is decided by location.
 *
 * Exported beside `stripHaiveContent` and `checkOnboardingMarkers` so the filesystem half is
 * testable without a request: the route adds only the row reads and the DB writes around it.
 */
export async function resetOnboardingArtifacts(
  root: string,
  provenance: OnboardingResetProvenance,
): Promise<OnboardingResetOutcome> {
  const { writtenHashes, haiveDirs, haiveEntries } = provenance;
  const removed: string[] = [];
  const cleaned: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const quarantined: Array<{ from: string; to: string }> = [];

  // A refusal is a per-item outcome, not a floor: one linked directory must not discard the
  // removal of the twenty beside it, and the reset says what it left alone instead of reporting
  // a clean run over a path it never touched.
  const guard = async (rel: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (!isPathContainmentError(err)) throw err;
      skipped.push({ path: rel, reason: err.reason });
    }
  };
  // `repairPermissions` on every item, as the whole-`.claude` removal this replaced had: it fires
  // only on EACCES/EPERM and only adds +0700 to the parent it already holds open, and a sweep of
  // entries must not fail where a removal of the directory around them succeeded.
  const remove = (rel: string, recursive: boolean): Promise<void> =>
    guard(rel, async () => {
      // The return value replaces a `pathExists` probe, and is strictly better evidence: the probe
      // could pass and the entry be gone — or replaced by a link — before the delete ran.
      if (await removeNoFollow(root, rel, { recursive, repairPermissions: true })) {
        removed.push(rel);
      }
    });

  // Settings first, so one the sweep must keep has its verdict before the sweep reaches it, and
  // one it may take is already gone from the listing.
  for (const rel of ONBOARDING_SETTINGS_FILES) {
    await guard(rel, async () => {
      const content = await readTextNoFollow(root, rel, { strict: true });
      if (content === null) return;
      const written = writtenHashes.get(rel);
      if (written !== undefined && written === sha256Hex(normalizeContent(content))) {
        if (await removeNoFollow(root, rel)) removed.push(rel);
        return;
      }
      skipped.push({
        path: rel,
        reason:
          written === undefined
            ? 'not recorded as written by Haive'
            : 'edited since Haive wrote it',
      });
    });
  }

  /** Whether a live artifact row covers this entry AND the bytes on disk are still the ones it
   *  recorded. A row on its own is not evidence: `recordOnboardingArtifacts` inserts one per
   *  manifest RENDERING without consulting `wroteFiles`, so a pre-existing user file that apply
   *  SKIPPED carries a row holding the hash of what Haive would have written. The same test the
   *  settings files use, for the same reason. A row deeper than the entry (a bundle skill's
   *  `<dir>/<id>/SKILL.md`) verifies the directory that contains it. */
  const artifactMatchesDisk = async (entry: string): Promise<boolean> => {
    for (const [diskPath, hash] of writtenHashes) {
      if (diskPath !== entry && !diskPath.startsWith(`${entry}/`)) continue;
      const content = await readTextNoFollow(root, diskPath, { strict: true }).catch(() => null);
      if (content !== null && sha256Hex(normalizeContent(content)) === hash) return true;
    }
    return false;
  };

  /** Move out what this directory holds that Haive cannot claim, so the removal after it takes
   *  only ours. 07's own mechanism and its own destination (`unmanagedAgentsDir`), because the
   *  quarantine checkbox defaults OFF: a definition the user wrote by hand legitimately sits in
   *  an agents dir beside ours, and there is no way to tell it from an old leftover. `noReplace`
   *  so a name already quarantined by an earlier run is never clobbered — which of the two a
   *  person wants is not ours to decide. */
  /** Whether anything claimed lives BENEATH this path, which is what decides a claimed directory
   *  is walked rather than taken whole: `<skills>/<id>` is ours AND holds `SKILL.md` and
   *  `sub-skills`, so a `NOTES.md` a person left beside them must still be moved out. A claimed
   *  directory with no deeper claims (`sub-skills` itself) is Haive's wholesale.
   *
   *  BOTH claim sources are asked. A directory on an upgraded or legacy repo can be claimed by a
   *  row alone (`<skills>/<id>/SKILL.md` verifying by hash), and reading only the step-recorded
   *  entries said "nothing below" for exactly those — so the walk was skipped and the file beside
   *  the matched artifact was deleted rather than moved. */
  const hasDeeperClaims = (rel: string): boolean => {
    const prefix = `${rel}/`;
    for (const entry of haiveEntries) if (entry.startsWith(prefix)) return true;
    for (const diskPath of writtenHashes.keys()) if (diskPath.startsWith(prefix)) return true;
    return false;
  };

  const quarantineForeign = async (
    dir: string,
    /** Where a moved entry goes. Fixed at the top level, so a descendant keeps its shape under
     *  the one `-legacy` sibling rather than growing a second one inside the tree. */
    legacyDir: string = unmanagedAgentsDir(dir),
  ): Promise<{ left: number; ours: Array<{ rel: string; isDir: boolean }> }> => {
    const entries = await readdirNoFollow(root, dir, { strict: true });
    const ours: Array<{ rel: string; isDir: boolean }> = [];
    if (entries === null) return { left: 0, ours };
    let left = 0;
    for (const entry of entries) {
      const from = `${dir}/${entry.name}`;
      // A claim names a FILE unless something inside it is named too — that is the invariant
      // `hasDeeperClaims` rests on. So a DIRECTORY standing where a claimed file was is not the
      // file Haive wrote: someone replaced it, and it is moved aside rather than removed with
      // everything in it.
      // Only a REGULAR FILE satisfies a file claim. A directory was round 13; a SYMLINK is the
      // same story — a person replaced the generated file with a link of their own, and
      // removing it unlinks something Haive never wrote.
      const claimed =
        (haiveEntries.has(from) || (await artifactMatchesDisk(from))) &&
        (entry.isFile() || (entry.isDirectory() && hasDeeperClaims(from)));
      if (claimed) {
        if (entry.isDirectory()) {
          const inner = await quarantineForeign(from, `${legacyDir}/${entry.name}`);
          left += inner.left;
          // The directory is ours only once nothing of theirs is left in it.
          if (inner.left === 0) ours.push({ rel: from, isDir: true });
          else ours.push(...inner.ours);
          continue;
        }
        ours.push({ rel: from, isDir: false });
        continue;
      }
      const to = `${legacyDir}/${entry.name}`;
      try {
        await renameNoFollow(root, from, to, { noReplace: true, createParents: true });
        quarantined.push({ from, to });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' && !isPathContainmentError(err)) {
          throw err;
        }
        // The name is taken, or the entry became a link between the listing and the move. Either
        // way it stays where it is, and the directory around it must then NOT be removed whole.
        left += 1;
        skipped.push({
          path: from,
          reason:
            (err as NodeJS.ErrnoException).code === 'EEXIST'
              ? 'already quarantined under that name'
              : (err as { reason: string }).reason,
        });
      }
    }
    return { left, ours };
  };

  /** Remove the claimed leaves under a `.claude` directory Haive wrote INTO but does not own,
   *  and drop the directory once nothing of the user's is left in it. Returns what stayed, so
   *  the caller knows whether `.claude` itself may still go. Nothing is moved here — see the
   *  sweep's note on why `.claude` leaves rather than quarantines. */
  const sweepClaimedChildren = async (dir: string): Promise<number> => {
    let left = 0;
    await guard(dir, async () => {
      const children = await readdirNoFollow(root, dir, { strict: true });
      if (children === null) return;
      for (const child of children) {
        const rel = `${dir}/${child.name}`;
        // A directory with anything claimed BELOW it is walked whether or not it is itself
        // claimed: `artifactMatchesDisk` answers true for an ancestor of a matching row, so a
        // row at `<dir>/<ours>/<file>` makes the directory holding it look wholly ours.
        if (child.isDirectory() && hasDeeperClaims(rel)) {
          left += await sweepClaimedChildren(rel);
          continue;
        }
        if (child.isFile() && (haiveEntries.has(rel) || (await artifactMatchesDisk(rel)))) {
          await remove(rel, false);
          continue;
        }
        left += 1;
        skipped.push({ path: rel, reason: 'no record that Haive wrote it' });
      }
      if (left === 0 && (await removeNoFollow(root, dir, { repairPermissions: true }))) {
        removed.push(dir);
      }
    });
    return left;
  };

  const dirs = onboardingResetDirs(haiveDirs);
  for (const rel of dirs.remove) {
    // KB and learnings are Haive's whole and hold no user definitions, so only the per-CLI dirs
    // are swept first.
    if (!haiveDirs.has(rel)) {
      await remove(rel, true);
      continue;
    }
    let swept = { left: 0, ours: [] as Array<{ rel: string; isDir: boolean }> };
    await guard(rel, async () => {
      swept = await quarantineForeign(rel);
    });
    // Something of the user's could not be moved out, so the directory cannot go whole: the
    // entries that ARE ours are removed instead and it stays, holding what was left behind.
    if (swept.left === 0) await remove(rel, true);
    else {
      for (const entry of swept.ours) await remove(entry.rel, entry.isDir);
    }
  }
  // A candidate Haive cannot be shown to have written is REPORTED, never removed: it is a
  // directory for a CLI this repo never had enabled, so everything in it is the user's.
  for (const rel of dirs.candidates) {
    await guard(rel, async () => {
      if ((await lstatNoFollow(root, rel, { strict: true })) === null) return;
      skipped.push({ path: rel, reason: 'no record that Haive wrote here' });
    });
  }

  // `.claude` is swept entry by entry rather than removed whole — see `keptSweepReason`. Strict,
  // so a linked `.claude` is reported rather than read as an empty directory.
  await guard(ONBOARDING_SWEEP_DIR, async () => {
    const entries = await readdirNoFollow(root, ONBOARDING_SWEEP_DIR, { strict: true });
    if (entries === null) return;
    let kept = 0;
    for (const entry of entries) {
      const rel = `${ONBOARDING_SWEEP_DIR}/${entry.name}`;
      const keep = keptSweepReason(entry.name);
      if (keep !== null) {
        kept += 1;
        skipped.push({ path: rel, reason: keep });
        continue;
      }
      // Still listed means the settings pass kept it, and reported why. The sweep must not
      // overrule that verdict.
      if (ONBOARDING_SETTINGS_FILES.includes(rel)) {
        kept += 1;
        continue;
      }
      // `.claude/agents` and `.claude/skills` are catalog directories: the loop above already
      // ruled on them, so one still here was declined or holds what could not be moved out.
      if (dirs.candidates.includes(rel) || dirs.remove.includes(rel)) {
        kept += 1;
        continue;
      }
      // Only what Haive is known to have written. `.claude` also holds things it never wrote —
      // a person's own `commands/`, `settings.local.json`, hooks — and the removal this replaced
      // took them, which the quarantine everywhere else exists to prevent. They are LEFT rather
      // than moved: `.claude` survives anyway (`mcp_settings.json` is kept), so there is nothing
      // to move them out of the way OF, and a `-legacy` sibling of it would be noise.
      // Haive wrote something BENEATH it — `.claude/plugins/drupal-php-lsp/<file>` under a
      // `plugins/` that also holds plugins the user installed. Removing the directory takes
      // theirs with ours, so it is walked and only the claimed leaves go. Asked BEFORE the
      // claim, because `artifactMatchesDisk` answers true for an ancestor of a matching row and
      // would otherwise make that `plugins/` look wholly ours.
      if (entry.isDirectory() && hasDeeperClaims(rel)) {
        if ((await sweepClaimedChildren(rel)) > 0) kept += 1;
        continue;
      }
      // A claim names a FILE unless something inside it is named too, so anything else standing
      // where a claimed file was — a directory, a symlink someone put there — is not the file
      // Haive wrote.
      if (!entry.isFile() || (!haiveEntries.has(rel) && !(await artifactMatchesDisk(rel)))) {
        kept += 1;
        skipped.push({ path: rel, reason: 'no record that Haive wrote it' });
        continue;
      }
      await remove(rel, false);
    }
    // Nothing of the user's in it: the directory goes too, as it always did.
    if (kept === 0) await remove(ONBOARDING_SWEEP_DIR, true);
  });

  // A CLI's own dot-dir is not Haive's and is never a removal target, but one the reset has just
  // emptied is left-over scaffolding rather than the user's — `rmdir` is used, so a directory
  // holding anything at all (a `.codex/config.toml`, an `agents-legacy`) is untouched.
  for (const parent of new Set(dirs.remove.map((rel) => rel.split('/')[0]!))) {
    if (!parent.startsWith('.') || parent === ONBOARDING_SWEEP_DIR) continue;
    await guard(parent, async () => {
      const left = await readdirNoFollow(root, parent, { strict: true });
      if (left !== null && left.length === 0 && (await removeNoFollow(root, parent))) {
        removed.push(parent);
      }
    });
  }

  for (const rel of ONBOARDING_RESET_FILES) await remove(rel, false);

  for (const rel of ONBOARDING_RULES_FILES) {
    await guard(rel, async () => {
      const result = await stripHaiveContent(root, rel);
      if (result === null) return;
      if (result.deleted) removed.push(rel);
      else if (result.changed) cleaned.push(rel);
    });
  }

  return { removed, cleaned, skipped, quarantined };
}

/** The repo's on-disk root, or a 404/409 explaining why there isn't one.
 *  Exported because the plan routes remove the committed `.haive-data/` mirror
 *  on delete and must resolve the root exactly as every other file route does —
 *  a second copy of this would be a second place for the storage/local
 *  fallback to drift. */
const execGit = promisify(execFile);

/**
 * Bind a repository that has no origin to one.
 *
 * A repository created `blank` or by upload has a real `git init` checkout and
 * no remote, so nothing can leave it — including the committed plan snapshot,
 * which is the only way a plan reaches another Haive install. Without this the
 * only route was to delete the repository and re-add it from a URL, which
 * throws away its plan, its tasks and its knowledge base.
 *
 * Runs in the api rather than the worker. `git remote set-url` writes one config
 * key: it moves no HEAD, touches no working tree and rewrites no history, which
 * is the line everything else respects — commit, push and the fast-forward pull
 * all remain worker jobs. The api already shells out (docker-cli, and the
 * read-only git probes behind the plan snapshot) against this same checkout.
 *
 * `source` is left alone on purpose. It records how the repository came to
 * exist, which is still true, and resolvers key on it.
 */
repoRoutes.post('/:id/remote', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = linkRepoRemoteRequestSchema.parse(await c.req.json());
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { id: true, storagePath: true, localPath: true, remoteUrl: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  const root = repo.storagePath ?? repo.localPath;
  if (!root) throw new HttpError(409, 'This repository has no resolvable path');

  if (body.credentialsId) {
    const cred = await db.query.repoCredentials.findFirst({
      where: and(
        eq(schema.repoCredentials.id, body.credentialsId),
        eq(schema.repoCredentials.userId, userId),
      ),
      columns: { id: true },
    });
    if (!cred) throw new HttpError(404, 'Credentials not found');
  }

  const git = async (args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await execGit('git', args, { cwd: root, timeout: 10_000 });
      return { ok: true, stdout: stdout.toString().trim(), stderr: stderr.toString().trim() };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return {
        ok: false,
        stdout: (e.stdout ?? '').toString().trim(),
        stderr: (e.stderr ?? '').toString().trim(),
      };
    }
  };

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    throw new HttpError(409, 'This repository is not a Git checkout, so it cannot have a remote');
  }

  // add-then-set-url rather than a `git remote` listing first: idempotent in one
  // round trip, and re-pointing an existing origin is a legitimate use of this.
  const added = await git(['remote', 'add', 'origin', body.remoteUrl]);
  if (!added.ok) {
    if (!/already exists/i.test(added.stderr)) {
      throw new HttpError(409, `Could not add the remote: ${added.stderr || added.stdout}`);
    }
    const updated = await git(['remote', 'set-url', 'origin', body.remoteUrl]);
    if (!updated.ok) {
      throw new HttpError(409, `Could not update the remote: ${updated.stderr || updated.stdout}`);
    }
  }

  // The row is written only after git accepted the URL, so the column can never
  // claim a remote the checkout does not have.
  await db
    .update(schema.repositories)
    .set({
      remoteUrl: body.remoteUrl,
      ...(body.credentialsId ? { credentialsSecretId: body.credentialsId } : {}),
      ...(body.branch ? { branch: body.branch } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, id));

  return c.json({ ok: true, remoteUrl: body.remoteUrl, relinked: repo.remoteUrl !== null });
});

export async function resolveRepoRoot(
  db: ReturnType<typeof getDb>,
  userId: string,
  id: string,
): Promise<string> {
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { storagePath: true, localPath: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  const root = repo.storagePath ?? repo.localPath;
  if (!root) throw new HttpError(409, 'Repository has no resolvable path');
  return root;
}

repoRoutes.get('/:id/onboarding-status', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { id: true, storagePath: true, localPath: true, onboardedAt: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  const root = repo.storagePath ?? repo.localPath;
  if (!root) throw new HttpError(409, 'Repository has no resolvable path');

  const { present, missing } = await checkOnboardingMarkers(root);
  const facts = (await loadOnboardingTaskFacts(db, userId, [id])).get(id) ?? NO_ONBOARDING_TASKS;
  const { onboarded, inProgressTaskId, canMarkOnboarded } = resolveOnboardingVerdict({
    missing,
    onboardedAt: repo.onboardedAt,
    facts,
  });
  return c.json({
    onboarded,
    present,
    missing,
    nothingToOnboard: onboarded ? false : !(await hasOnboardableSource(root)),
    onboardingTaskId: inProgressTaskId,
    canMarkOnboarded,
  });
});

/**
 * Record that this repository is onboarded, without a run having said so.
 *
 * The escape hatch for a run that did all the work and then failed at a late step — the KB,
 * the agents and the skills are all on disk, but no task ever reached `completed`, so the
 * verdict would otherwise stay "not onboarded" forever and the only route back would be the
 * destructive artifact reset.
 *
 * Refuses when a marker is missing (there is nothing to vouch for) or while a run is live
 * (the answer is minutes away, and marking it now would be a claim about work still in
 * flight). Idempotent: re-marking an already-marked repo just moves the date.
 */
repoRoutes.post('/:id/mark-onboarded', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const root = await resolveRepoRoot(db, userId, id);

  const { missing } = await checkOnboardingMarkers(root);
  if (missing.length > 0) {
    throw new HttpError(
      409,
      `This repository is missing onboarding artifacts (${missing.join(', ')}), so it cannot be marked onboarded. Run onboarding instead.`,
    );
  }
  const facts = (await loadOnboardingTaskFacts(db, userId, [id])).get(id) ?? NO_ONBOARDING_TASKS;
  if (facts.liveTaskId) {
    throw new HttpError(409, 'An onboarding run is still in progress for this repository');
  }

  const onboardedAt = new Date();
  await db
    .update(schema.repositories)
    .set({ onboardedAt, updatedAt: new Date() })
    .where(eq(schema.repositories.id, id));
  return c.json({ ok: true, onboardedAt: onboardedAt.toISOString() });
});

repoRoutes.get('/:id/archive', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { name: true, status: true, storagePath: true, localPath: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
  if (repo.status !== 'ready') throw new HttpError(409, 'Repository is not ready to download');
  const root = repo.storagePath ?? repo.localPath;
  if (!root) throw new HttpError(409, 'Repository has no resolvable path');

  const { stream, filename } = await createRepoArchiveStream(root, repo.name);

  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');

  return c.body(Readable.toWeb(stream) as ReadableStream);
});

repoRoutes.delete('/:id/onboarding-artifacts', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  // A live onboarding run writes into the very tree this is about to delete — and its 07/09_5
  // steps may complete AFTER the reset, so their records would name files the reset removed
  // while carrying a `created_at` older than the epoch, which excludes that run's provenance
  // for good. The timestamp cannot express that; the request has to be refused. Same live-task
  // rule the onboarded verdict uses, so the two cannot drift.
  const facts = (await loadOnboardingTaskFacts(db, userId, [id])).get(id) ?? NO_ONBOARDING_TASKS;
  // `onboarding_upgrade` is a SECOND root writer and `loadOnboardingTaskFacts` cannot see it —
  // that helper is filtered to `type = 'onboarding'` because it also answers the ONBOARDED
  // verdict, where a running upgrade must not make a repo read un-onboarded. `02-upgrade-apply`
  // writes straight to the repo path and then supersedes and re-inserts the same
  // `onboarding_artifacts` rows, so racing it deletes files it just wrote or strips rows it is
  // still working from.
  const liveUpgrade = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.repositoryId, id),
        eq(schema.tasks.type, 'onboarding_upgrade'),
        inArray(schema.tasks.status, LIVE_TASK_STATUSES),
      ),
    )
    .limit(1);
  if (facts.liveTaskId !== null || liveUpgrade.length > 0) {
    throw new HttpError(
      409,
      'An onboarding run is in progress on this repository. Wait for it to finish or cancel it before resetting.',
    );
  }

  // The epoch is taken BEFORE any reading or deleting, not when the row is finally written.
  // Nothing serializes an onboarding task against this endpoint — `POST /tasks` refuses only a
  // second LIVE onboarding — so a task created while this request is walking the tree would
  // carry a `created_at` older than an end-of-request stamp, and `loadProvenanceSteps` would
  // exclude that run for good. Its writes land after the reset, so it belongs on the new side.
  const resetStartedAt = new Date();
  const repoRow = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { onboardingResetAt: true },
  });
  const root = await resolveRepoRoot(db, userId, id);

  // Read BEFORE the reset: these rows are what says whether a file Haive can write is one it
  // wrote, and they are superseded below.
  const live = await db
    .select({
      diskPath: schema.onboardingArtifacts.diskPath,
      writtenHash: schema.onboardingArtifacts.writtenHash,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, id),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );

  const onboardingSteps = await loadProvenanceSteps(db, id, repoRow?.onboardingResetAt ?? null);
  const written = collectWrittenCliContent(onboardingSteps, live);

  const { removed, cleaned, skipped, quarantined } = await resetOnboardingArtifacts(root, {
    writtenHashes: new Map(live.map((row) => [row.diskPath, row.writtenHash])),
    haiveDirs: written.dirs,
    haiveEntries: written.entries,
  });

  // Rows that name deleted files must not stay live: they feed the upgrade planner and the
  // rollback, and `12-post-onboarding` inserts without conflict handling, so a re-onboarding
  // would collide with the (repository_id, disk_path) WHERE superseded_at IS NULL unique index.
  // Same defensive supersede as `02-upgrade-apply`. `applicableTemplateIds` is left alone — the
  // next apply overwrites it, and with no live rows the banner already reads "not onboarded".
  await db
    .update(schema.onboardingArtifacts)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, id),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );
  // The completion stamp cannot outlive the files it vouches for: this is the "start over"
  // action, and a repo whose artifacts are gone is not onboarded however it got marked.
  await db
    .update(schema.repositories)
    .set({ onboardedAt: null, onboardingResetAt: resetStartedAt, updatedAt: new Date() })
    .where(eq(schema.repositories.id, id));
  return c.json({ ok: true, removed, cleaned, skipped, quarantined });
});

repoRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();

  // Cancel any non-terminal tasks pinned to this repo BEFORE the delete so
  // their CANCEL job tears down sandboxes, terminal sessions, env images,
  // and auth volumes cleanly. The schema's `set null` cascade would
  // otherwise orphan running tasks: status untouched, repo gone, sandboxes
  // pointing at a workdir that no longer exists.
  const cancelled: Array<{ id: string }> = [];
  let repoFound = false;
  let internalRagProjectNames: string[] = [];
  let storagePath: string | null = null;
  let capturedTasks: { id: string; envTemplateId: string | null }[] = [];

  await db.transaction(async (tx) => {
    const repoRows = await tx
      .select({
        id: schema.repositories.id,
        storagePath: schema.repositories.storagePath,
        onboardingTooling: schema.repositories.onboardingTooling,
        onboardingEnvironment: schema.repositories.onboardingEnvironment,
      })
      .from(schema.repositories)
      .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)));
    if (repoRows.length === 0) return;
    repoFound = true;
    storagePath = repoRows[0]!.storagePath;

    // Capture project names of this repo's internal-mode RAG tasks before
    // the delete cascades `tasks.repository_id` to NULL. After cascade the
    // worker can no longer trace tasks back to this repo, so the project
    // names must travel in the cleanup job payload. The mirror columns go with
    // them: a repo restored from a committed `.haive-data/` has no onboarding
    // task, so they are the only record of the project name it indexed under.
    internalRagProjectNames = await collectInternalRagProjectNamesForRepo(tx, id, userId, {
      onboardingTooling: repoRows[0]!.onboardingTooling,
      onboardingEnvironment: repoRows[0]!.onboardingEnvironment,
    });

    // Same reason: capture the repo's tasks (+ their env templates) before the
    // cascade, so the resource-cleanup worker can tear down runners/images it
    // could no longer trace once repository_id is NULL.
    capturedTasks = await tx
      .select({ id: schema.tasks.id, envTemplateId: schema.tasks.envTemplateId })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.repositoryId, id), eq(schema.tasks.userId, userId)));

    const open = await cancelOpenTasksForRepo(tx, id, userId);
    cancelled.push(...open);

    await tx
      .delete(schema.repositories)
      .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)));
  });

  if (!repoFound) throw new HttpError(404, 'Repository not found');

  // Enqueue CANCEL jobs AFTER commit. Pre-commit enqueueing would race
  // with rollback (worker would tear down sandboxes for tasks still marked
  // running in the DB).
  for (const t of cancelled) {
    await enqueueCancelJob(t.id, userId);
  }

  // Enqueue the per-project RAG cleanup job AFTER commit so the worker's
  // collision check sees the post-delete state of the tasks table. External
  // and ddev RAG modes were filtered out at collection time — this only
  // touches internal-mode databases Haive owns.
  await enqueueRepoRagCleanupJob({
    repositoryId: id,
    userId,
    projectNames: internalRagProjectNames,
  });

  // Tear down the repo's leftover Docker resources + workspace files (DDEV/app
  // runners, env images no longer referenced by a surviving task, haive_repos
  // files) — the cancel jobs above only cover open tasks, not terminal ones.
  await enqueueRepoResourceCleanupJob({
    userId,
    repositoryId: id,
    taskIds: capturedTasks.map((t) => t.id),
    envTemplateIds: Array.from(
      new Set(capturedTasks.map((t) => t.envTemplateId).filter((x): x is string => x !== null)),
    ),
    storagePath,
  });

  return c.json({
    ok: true,
    cancelledTasks: cancelled.length,
    ragProjectsToClean: internalRagProjectNames.length,
  });
});

repoRoutes.post('/:id/refresh-tree', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  await db
    .update(schema.repositories)
    .set({ status: 'cloning', statusMessage: null, updatedAt: new Date() })
    .where(eq(schema.repositories.id, id));

  const queue = getRepoQueue();
  const payload: RepoJobPayload = {
    repositoryId: repo.id,
    userId,
    source: repo.source,
    ...(repo.localPath ? { localPath: repo.localPath } : {}),
    ...(repo.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
    ...(repo.branch ? { branch: repo.branch } : {}),
    ...(repo.credentialsSecretId ? { credentialsId: repo.credentialsSecretId } : {}),
  };
  const jobName =
    repo.source === 'local_path'
      ? repo.writable
        ? REPO_JOB_NAMES.COPY
        : REPO_JOB_NAMES.SCAN
      : REPO_JOB_NAMES.CLONE;
  await queue.add(jobName, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });

  return c.json({ ok: true });
});
