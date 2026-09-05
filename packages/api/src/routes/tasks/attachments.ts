import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, chown, mkdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  ATTACHMENTS_MANIFEST_NAME,
  attachmentUploadsRoot,
  AttachmentPathError,
  CONFIG_KEYS,
  configService,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  isReadOnlyLocalRepo,
  renderAttachmentsManifest,
  sanitizeAttachmentPath,
  splitAttachmentPath,
  uploadTaskAttachmentQuerySchema,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';

// User-supplied reference files attached to a task (docs, screenshots, sample
// data). Stored on the haive_repos volume under
// `<repoRoot>/.haive/task-uploads/<taskId>/` so the AI CLI agent reads them at
// `/haive/workdir/.haive/task-uploads/<taskId>/`. `.haive/` is git-excluded, so
// the files are durable and never show in the agent's git status. Auth + userId
// come from the parent taskRoutes (requireAuth), mirroring files.ts / steps.ts.
//
// The api container runs as root; repo dirs are owned by `node` (uid 1000, the
// sandbox user). We write the files then chown 1000:1000 + chmod 0644 so the
// agent can read them.

export const attachmentRoutes = new Hono<AppEnv>();

const NODE_UID = 1000;
const NODE_GID = 1000;
/** Names the uploads dir owns. An upload allowed to take one of these is
 *  overwritten the next time that file is generated — the user's document
 *  silently replaced by our index, with their attachment row still pointing at
 *  it. `_PLAN_INPUTS.md` is written by the worker's 00-plan-inputs step; it is
 *  listed here rather than imported because the api must not depend on the
 *  worker, and a name the api hands out is a name the api has to reserve. */
const RESERVED_NAMES = new Set([ATTACHMENTS_MANIFEST_NAME, '_PLAN_INPUTS.md']);

/** Resolve the task's on-disk uploads dir, enforcing ownership + a writable
 *  volume-backed repo. Throws 404/409 with an actionable message otherwise. */
async function resolveTaskUploadsDir(taskId: string, userId: string): Promise<string> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true, repositoryId: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (!task.repositoryId) {
    throw new HttpError(409, 'Task has no repository; cannot attach files');
  }
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { source: true, writable: true, storagePath: true },
  });
  if (!repo) throw new HttpError(409, 'Task repository not found');
  if (isReadOnlyLocalRepo(repo)) {
    throw new HttpError(409, 'Attachments are not supported for read-only local repositories');
  }
  if (!repo.storagePath) {
    throw new HttpError(409, 'Task repository is not ready yet');
  }
  return join(repo.storagePath, '.haive', 'task-uploads', taskId);
}

/** 404 unless the task exists and belongs to the user. */
async function requireOwnedTask(taskId: string, userId: string): Promise<void> {
  const db = getDb();
  const row = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!row) throw new HttpError(404, 'Task not found');
}

async function findAttachment(taskId: string, userId: string, attachmentId: string) {
  const db = getDb();
  const row = await db.query.taskAttachments.findFirst({
    where: and(
      eq(schema.taskAttachments.id, attachmentId),
      eq(schema.taskAttachments.taskId, taskId),
      eq(schema.taskAttachments.userId, userId),
    ),
  });
  if (!row) throw new HttpError(404, 'Attachment not found');
  return row;
}

function toClient(row: typeof schema.taskAttachments.$inferSelect) {
  return {
    id: row.id,
    taskId: row.taskId,
    filename: row.filename,
    sizeBytes: Number(row.sizeBytes),
    contentType: row.contentType,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The sanitised relative path, or a 400. Path rules live in `@haive/shared` so
 *  the worker's archive expansion applies exactly the same ones — a name one of
 *  them refuses and the other accepts is a file only one can find. */
function safeAttachmentPath(raw: string): string {
  try {
    return sanitizeAttachmentPath(raw);
  } catch (err) {
    if (err instanceof AttachmentPathError) throw new HttpError(400, err.message);
    throw err;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** `candidate` resolved under `root`, or null. Cheap insurance on the paths that
 *  drive an `rm`: the sanitiser already forbids traversal, and a delete is the
 *  one operation where being wrong about that is unrecoverable. */
function resolveInside(root: string, relative: string): string | null {
  const base = resolve(root);
  const candidate = resolve(base, relative);
  return candidate === base || candidate.startsWith(base + sep) ? candidate : null;
}

/** Make every level of `relDir` under the uploads root traversable + owned by the
 *  sandbox user. A folder upload creates directories the api never touched. */
async function ensureDirTree(root: string, relDir: string): Promise<void> {
  if (relDir === '') return;
  let cursor = root;
  for (const segment of relDir.split('/')) {
    cursor = join(cursor, segment);
    await mkdir(cursor, { recursive: true });
    await chmod(cursor, 0o755).catch(() => {});
    await chown(cursor, NODE_UID, NODE_GID).catch(() => {});
  }
}

/** De-dupe within the file's OWN directory by appending ` (n)` before the
 *  extension, and create that directory. Per-directory because two folders'
 *  `README.md` are two documents, not a collision. Reserved names bite only at
 *  the root, which is where the generated indexes live. */
async function uniquePath(dir: string, relPath: string): Promise<string> {
  const { dir: relDir, base } = splitAttachmentPath(relPath);
  await ensureDirTree(dir, relDir);
  const parent = relDir === '' ? dir : join(dir, relDir);
  const reserved = (name: string): boolean => relDir === '' && RESERVED_NAMES.has(name);
  const rel = (name: string): string => (relDir === '' ? name : `${relDir}/${name}`);

  if (!(await pathExists(join(parent, base))) && !reserved(base)) return rel(base);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let n = 1;
  let candidate = base;
  do {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  } while ((await pathExists(join(parent, candidate))) || reserved(candidate));
  return rel(candidate);
}

/** Remove the directories a deleted file left empty, stopping at the uploads root
 *  or at the first directory something else still lives in. */
async function pruneEmptyDirs(root: string, relDir: string): Promise<void> {
  let cursor = relDir;
  while (cursor !== '' && cursor !== '.') {
    const abs = resolveInside(root, cursor);
    if (!abs) return;
    try {
      await rmdir(abs);
    } catch {
      return; // not empty, or already gone
    }
    cursor = splitAttachmentPath(cursor).dir;
  }
}

/** Stream the request body to `destPath`, aborting + unlinking once the byte count
 *  exceeds `maxBytes` (413). Streaming keeps memory bounded regardless of the cap. */
async function streamToFileWithCap(
  body: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  const nodeStream = Readable.fromWeb(body as never);
  const writeStream = createWriteStream(destPath);
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('data', (buf: Buffer) => {
        total += buf.length;
        if (total > maxBytes) {
          nodeStream.destroy();
          writeStream.destroy();
          reject(new HttpError(413, `attachment exceeds ${maxBytes} bytes limit`));
        }
      });
      nodeStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      nodeStream.pipe(writeStream);
    });
  } catch (err) {
    await rm(destPath, { force: true }).catch(() => {});
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `attachment write failed: ${(err as Error).message}`);
  }
  return total;
}

/** Rewrite `<dir>/_ATTACHMENTS.md` from the task's current rows (or delete it when
 *  none remain). Read by the agent for per-file descriptions. */
async function regenerateManifest(dir: string, taskId: string): Promise<void> {
  const db = getDb();
  const rows = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.taskId, taskId),
    orderBy: asc(schema.taskAttachments.createdAt),
  });
  const manifestPath = join(dir, ATTACHMENTS_MANIFEST_NAME);
  const body = renderAttachmentsManifest(rows);
  if (body === null) {
    await rm(manifestPath, { force: true }).catch(() => {});
    return;
  }
  await writeFile(manifestPath, body, 'utf8');
  await chmod(manifestPath, 0o644).catch(() => {});
  await chown(manifestPath, NODE_UID, NODE_GID).catch(() => {});
}

/** Make a freshly-created dir traversable + owned by the sandbox user. Best-effort
 *  (the api is root; failures are non-fatal since 0755/0644 are world-readable). */
async function harmonizeDirOwnership(dir: string): Promise<void> {
  for (const d of [dirname(dir), dir]) {
    await chmod(d, 0o755).catch(() => {});
    await chown(d, NODE_UID, NODE_GID).catch(() => {});
  }
}

function headerContentType(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.split(';')[0]?.trim() ?? '';
  if (!v || v === 'application/octet-stream') return null;
  return v.slice(0, 128);
}

/**
 * Everything that happens AFTER an attachment's bytes are on disk: permissions,
 * the `task_attachments` row, and the manifest rewrite.
 *
 * One tail for every write path, because two of the three things it does fail
 * invisibly. The api runs as root while the sandbox user is uid 1000, so a file
 * written without the chown reaches the agent as a permission error and only
 * inside a container. And `augmentPromptWithAttachments` tells EVERY agent to
 * read `_ATTACHMENTS.md` unconditionally — a write path that skips the manifest
 * therefore hands the agent a prompt pointing at a file that does not exist.
 *
 * Returns the inserted row.
 */
async function finalizeAttachment(args: {
  dir: string;
  destPath: string;
  filename: string;
  taskId: string;
  userId: string;
  sizeBytes: number;
  contentType: string | null;
  description: string | null;
}) {
  await chmod(args.destPath, 0o644).catch(() => {});
  await chown(args.destPath, NODE_UID, NODE_GID).catch(() => {});

  const inserted = await getDb()
    .insert(schema.taskAttachments)
    .values({
      taskId: args.taskId,
      userId: args.userId,
      filename: args.filename,
      storedPath: args.destPath,
      sizeBytes: args.sizeBytes,
      contentType: args.contentType,
      description: args.description,
    })
    .returning();

  await regenerateManifest(args.dir, args.taskId);
  return inserted[0]!;
}

/**
 * Write one attachment from bytes already in memory.
 *
 * Sibling of the streaming route below, sharing its tail. Kept separate because
 * the route streams with a byte cap and this takes a whole buffer.
 */
export async function writeTaskAttachment(args: {
  taskId: string;
  userId: string;
  filename: string;
  content: string | Buffer;
  contentType?: string | null;
  description?: string | null;
}) {
  const dir = await resolveTaskUploadsDir(args.taskId, args.userId);
  await mkdir(dir, { recursive: true });
  await harmonizeDirOwnership(dir);

  const safeName = await uniquePath(dir, safeAttachmentPath(args.filename));
  const destPath = join(dir, safeName);
  await writeFile(destPath, args.content);
  const { size } = await stat(destPath);

  return finalizeAttachment({
    dir,
    destPath,
    filename: safeName,
    taskId: args.taskId,
    userId: args.userId,
    sizeBytes: size,
    contentType: args.contentType ?? null,
    description: args.description ?? null,
  });
}

attachmentRoutes.post('/:id/attachments', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const dir = await resolveTaskUploadsDir(taskId, userId);

  const query = uploadTaskAttachmentQuerySchema.parse({
    filename: c.req.query('filename'),
    description: c.req.query('description'),
  });

  const body = c.req.raw.body;
  if (!body) throw new HttpError(400, 'request body is empty');

  const maxBytes = await configService.getNumber(
    CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES,
    DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  );

  await mkdir(dir, { recursive: true });
  await harmonizeDirOwnership(dir);

  const safeName = await uniquePath(dir, safeAttachmentPath(query.filename));
  const destPath = join(dir, safeName);
  const size = await streamToFileWithCap(body, destPath, maxBytes);

  const row = await finalizeAttachment({
    dir,
    destPath,
    filename: safeName,
    taskId,
    userId,
    sizeBytes: size,
    contentType: headerContentType(c.req.header('content-type')),
    description: query.description ?? null,
  });
  return c.json({ attachment: toClient(row) }, 201);
});

attachmentRoutes.get('/:id/attachments', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  await requireOwnedTask(taskId, userId);

  const db = getDb();
  const rows = await db.query.taskAttachments.findMany({
    where: and(
      eq(schema.taskAttachments.taskId, taskId),
      eq(schema.taskAttachments.userId, userId),
    ),
    orderBy: asc(schema.taskAttachments.createdAt),
  });
  return c.json({ attachments: rows.map(toClient) });
});

attachmentRoutes.get('/:id/attachments/:attachmentId/raw', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const attachmentId = c.req.param('attachmentId');
  await requireOwnedTask(taskId, userId);
  const row = await findAttachment(taskId, userId, attachmentId);

  const onDisk = await stat(row.storedPath).catch(() => null);
  if (!onDisk) throw new HttpError(404, 'Attachment file is missing on disk');

  // The BASENAME: `filename` may be a relative path now, and a header carrying
  // `docs/api/spec.md` names a directory the downloader does not have.
  const safeHeaderName = splitAttachmentPath(row.filename).base.replace(/["\r\n]/g, '_');
  c.header('Content-Type', row.contentType ?? 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${safeHeaderName}"`);
  c.header('Content-Length', String(onDisk.size));
  c.header('Cache-Control', 'no-store');
  return c.body(Readable.toWeb(createReadStream(row.storedPath)) as never);
});

attachmentRoutes.delete('/:id/attachments/:attachmentId', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const attachmentId = c.req.param('attachmentId');
  await requireOwnedTask(taskId, userId);
  const row = await findAttachment(taskId, userId, attachmentId);

  const db = getDb();
  const root = attachmentUploadsRoot(row);

  // Files this row produced by being expanded. Their ROWS cascade on the delete
  // below, but the FK cannot reach the disk — and an orphaned tree stays
  // bind-mounted into the sandbox, so an agent would keep reading files the user
  // believes they removed. Every child lives under one directory (the expansion
  // dir), which is what gets removed, sidecars and all.
  const children = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.expandedFromId, attachmentId),
    columns: { filename: true },
    limit: 1,
  });
  const expansionDir = children[0]
    ? (splitAttachmentPath(children[0].filename).dir.split('/')[0] ?? '')
    : '';
  if (expansionDir !== '') {
    const dirPath = resolveInside(root, expansionDir);
    if (dirPath) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
  }

  await rm(row.storedPath, { force: true }).catch(() => {});
  await db.delete(schema.taskAttachments).where(eq(schema.taskAttachments.id, attachmentId));
  await pruneEmptyDirs(root, splitAttachmentPath(row.filename).dir);
  await regenerateManifest(root, taskId);
  return c.json({ ok: true });
});

/** Remove a whole uploaded folder. A 400-file tree cannot be taken apart a row at
 *  a time from the UI, and the directory itself has to go with the rows. */
attachmentRoutes.delete('/:id/attachments', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  await requireOwnedTask(taskId, userId);
  const raw = c.req.query('prefix');
  if (!raw) throw new HttpError(400, 'prefix query parameter is required');
  const prefix = safeAttachmentPath(raw);

  const db = getDb();
  const rows = await db.query.taskAttachments.findMany({
    where: and(
      eq(schema.taskAttachments.taskId, taskId),
      eq(schema.taskAttachments.userId, userId),
    ),
  });
  // Filtered here rather than with a SQL LIKE: `_` is a LIKE wildcard AND a legal
  // filename character, so `docs_v2/a.md` would match a `docs/v2` prefix.
  const marked = rows.filter((r) => r.filename.startsWith(`${prefix}/`));
  if (marked.length === 0) throw new HttpError(404, `No attachments under "${prefix}/"`);

  const root = attachmentUploadsRoot(marked[0]!);
  const dirPath = resolveInside(root, prefix);
  if (!dirPath) throw new HttpError(400, 'prefix does not resolve inside the uploads directory');
  // Recursive on purpose: the tree also holds the worker's extracted sidecars,
  // which carry no row of their own and are meaningless once the originals go.
  await rm(dirPath, { recursive: true, force: true }).catch(() => {});
  await db.delete(schema.taskAttachments).where(
    inArray(
      schema.taskAttachments.id,
      marked.map((r) => r.id),
    ),
  );
  await pruneEmptyDirs(root, splitAttachmentPath(prefix).dir);
  await regenerateManifest(root, taskId);
  return c.json({ ok: true, removed: marked.length });
});
