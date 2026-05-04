import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  createRepoRequestSchema,
  initRepoUploadRequestSchema,
  REPO_JOB_NAMES,
  updateRepoExclusionsRequestSchema,
  type ArchiveFormat,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRepoQueue, type RepoJobPayload } from '../queues.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import {
  cancelOpenTasksForRepo,
  collectInternalRagProjectNamesForRepo,
  enqueueCancelJob,
  enqueueRepoRagCleanupJob,
} from '../lib/cancel-task.js';
import { validateLocalPath, pathExists, isGitRepository } from '../lib/filesystem.js';

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

function repoStorageRoot(): string {
  return process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
}

function deriveRepoName(opts: {
  name?: string;
  remoteUrl?: string;
  localPath?: string;
  filename?: string;
}): string {
  if (opts.name?.trim()) return opts.name.trim();
  if (opts.remoteUrl) {
    try {
      const last = new URL(opts.remoteUrl).pathname.split('/').filter(Boolean).pop();
      if (last) return last.replace(/\.git$/, '');
    } catch {
      // malformed URL — fall through
    }
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

export const repoRoutes = new Hono<AppEnv>();

repoRoutes.use('*', requireAuth);

repoRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.repositories.findMany({
    where: eq(schema.repositories.userId, userId),
    orderBy: [desc(schema.repositories.createdAt)],
  });
  return c.json({ repositories: rows });
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
  const jobName = body.source === 'local_path' ? REPO_JOB_NAMES.SCAN : REPO_JOB_NAMES.CLONE;
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

  const uploadDir = path.join(repoStorageRoot(), '_uploads', userId);
  await mkdir(uploadDir, { recursive: true });
  const ext = format === 'tar.gz' ? 'tar.gz' : format;
  const archivePath = path.join(uploadDir, `${repo.id}.${ext}`);

  try {
    const body = archiveField.stream() as unknown as ReadableStream<Uint8Array>;
    const nodeStream = Readable.fromWeb(body as never);
    await pipeline(nodeStream, createWriteStream(archivePath));
    const written = await stat(archivePath);
    if (written.size > maxUploadBytes()) {
      throw new HttpError(413, `archive exceeds ${maxUploadBytes()} bytes limit`);
    }
  } catch (err) {
    await rm(archivePath, { force: true }).catch(() => {});
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

  const uploadDir = path.join(repoStorageRoot(), '_uploads', userId);
  await mkdir(uploadDir, { recursive: true });

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
  const archivePath = path.join(uploadDir, `${session.id}.${ext}.partial`);
  const fh = await open(archivePath, 'w');
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
  const nodeStream = Readable.fromWeb(rawBody as never);
  const writeStream = createWriteStream(row.archivePath, { flags: 'a' });
  let written = 0;
  nodeStream.on('data', (buf: Buffer) => {
    written += buf.length;
  });
  try {
    await pipeline(nodeStream, writeStream);
  } catch (err) {
    const fh = await open(row.archivePath, 'r+');
    try {
      await fh.truncate(Number(row.bytesReceived));
    } finally {
      await fh.close();
    }
    throw new HttpError(500, `chunk write failed: ${(err as Error).message}`);
  }
  if (written !== expectedLen) {
    const fh = await open(row.archivePath, 'r+');
    try {
      await fh.truncate(Number(row.bytesReceived));
    } finally {
      await fh.close();
    }
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

  const onDisk = await stat(row.archivePath).catch(() => null);
  if (!onDisk || onDisk.size !== Number(row.totalSize)) {
    throw new HttpError(409, 'archive size mismatch on disk');
  }

  const finalPath = row.archivePath.replace(/\.partial$/, '');
  if (finalPath === row.archivePath) {
    throw new HttpError(500, 'archive path missing .partial suffix');
  }
  await rename(row.archivePath, finalPath);

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
  await rm(row.archivePath, { force: true }).catch(() => {});
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

repoRoutes.patch('/:id/exclusions', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = updateRepoExclusionsRequestSchema.parse(await c.req.json());
  const db = getDb();

  const repo = await db.query.repositories.findFirst({
    where: and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)),
    columns: { id: true, fileTree: true, excludedPaths: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');

  const fileTree = repo.fileTree ?? [];
  const topLevel = new Set<string>();
  for (const file of fileTree) {
    const segment = file.split('/')[0];
    if (segment) topLevel.add(segment);
  }
  // Also accept paths already stored as exclusions (e.g. framework defaults
  // like .git, .DS_Store that buildFileTree skips during scanning)
  const existingExcluded = new Set(
    (repo.excludedPaths ?? []).map((p) => p.replace(/^\/+|\/+$/g, '')),
  );
  const invalid = body.excludedPaths.filter((p) => {
    const head = p.replace(/^\/+/, '').split('/')[0];
    if (!head) return true;
    return !topLevel.has(head) && !existingExcluded.has(head);
  });
  if (invalid.length > 0) {
    throw new HttpError(400, `Unknown paths: ${invalid.slice(0, 5).join(', ')}`);
  }

  const selectedPaths = Array.from(topLevel).filter(
    (d) => !body.excludedPaths.some((e) => d === e.replace(/^\/+|\/+$/g, '')),
  );

  const updated = await db
    .update(schema.repositories)
    .set({
      excludedPaths: body.excludedPaths,
      selectedPaths,
      updatedAt: new Date(),
    })
    .where(eq(schema.repositories.id, id))
    .returning();
  return c.json({ repository: updated[0]! });
});

const ONBOARDING_MARKERS = [
  '.claude/knowledge_base',
  '.claude/agents',
  '.claude/skills',
  '.claude/workflow-config.json',
];

const ONBOARDING_RESET_DIRS = ['.claude'];
const ONBOARDING_RESET_FILES = ['.ripgreprc'];
const ONBOARDING_RULES_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const HAIVE_MARKER_PAIRS: Array<[string, string]> = [
  ['<!-- haive:project-info -->', '<!-- /haive:project-info -->'],
  ['<!-- haive:cli-rules -->', '<!-- /haive:cli-rules -->'],
];

async function stripHaiveContent(full: string): Promise<{ changed: boolean; deleted: boolean }> {
  const content = await readFile(full, 'utf8');
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
    await rm(full, { force: true });
    return { changed: true, deleted: true };
  }
  await writeFile(full, cleaned + '\n', 'utf8');
  return { changed: true, deleted: false };
}

async function resolveRepoRoot(
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
  const root = await resolveRepoRoot(db, userId, id);

  const present: string[] = [];
  const missing: string[] = [];
  for (const rel of ONBOARDING_MARKERS) {
    if (await pathExists(path.join(root, rel))) present.push(rel);
    else missing.push(rel);
  }
  return c.json({ onboarded: missing.length === 0, present, missing });
});

repoRoutes.delete('/:id/onboarding-artifacts', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const root = await resolveRepoRoot(db, userId, id);

  const removed: string[] = [];
  const cleaned: string[] = [];

  for (const rel of ONBOARDING_RESET_DIRS) {
    const full = path.join(root, rel);
    if (await pathExists(full)) {
      await rm(full, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  for (const rel of ONBOARDING_RESET_FILES) {
    const full = path.join(root, rel);
    if (await pathExists(full)) {
      await rm(full, { force: true });
      removed.push(rel);
    }
  }
  for (const rel of ONBOARDING_RULES_FILES) {
    const full = path.join(root, rel);
    if (!(await pathExists(full))) continue;
    const result = await stripHaiveContent(full);
    if (result.deleted) removed.push(rel);
    else if (result.changed) cleaned.push(rel);
  }
  return c.json({ ok: true, removed, cleaned });
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

  await db.transaction(async (tx) => {
    const repoRows = await tx
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)));
    if (repoRows.length === 0) return;
    repoFound = true;

    // Capture project names of this repo's internal-mode RAG tasks before
    // the delete cascades `tasks.repository_id` to NULL. After cascade the
    // worker can no longer trace tasks back to this repo, so the project
    // names must travel in the cleanup job payload.
    internalRagProjectNames = await collectInternalRagProjectNamesForRepo(tx, id, userId);

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
  const jobName = repo.source === 'local_path' ? REPO_JOB_NAMES.SCAN : REPO_JOB_NAMES.CLONE;
  await queue.add(jobName, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });

  return c.json({ ok: true });
});
