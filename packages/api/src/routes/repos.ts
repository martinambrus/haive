import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  createRepoRequestSchema,
  REPO_JOB_NAMES,
  updateRepoExclusionsRequestSchema,
  type ArchiveFormat,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRepoQueue, type RepoJobPayload } from '../queues.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { validateLocalPath, pathExists, isGitRepository } from '../lib/filesystem.js';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
  if (archiveField.size > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, `archive exceeds ${MAX_UPLOAD_BYTES} bytes limit`);
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
    if (written.size > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `archive exceeds ${MAX_UPLOAD_BYTES} bytes limit`);
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
  await queue.add(REPO_JOB_NAMES.EXTRACT, payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ repository: repo }, 201);
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

repoRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const result = await db
    .delete(schema.repositories)
    .where(and(eq(schema.repositories.id, id), eq(schema.repositories.userId, userId)))
    .returning({ id: schema.repositories.id });
  if (result.length === 0) throw new HttpError(404, 'Repository not found');
  return c.json({ ok: true });
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
