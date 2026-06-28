import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, chown, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  isReadOnlyLocalRepo,
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
const MANIFEST_NAME = '_ATTACHMENTS.md';

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

/** Reduce an uploaded filename to a safe basename: no path separators, no control
 *  chars, no leading dots (blocks `..` and dotfiles). Path traversal is therefore
 *  impossible. */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // Allowlist printable filename chars; everything else (control chars, path
    // separators, quotes, unicode) becomes '_'. No path traversal survives.
    .replace(/[^\w .()\-]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'file').slice(0, 200);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** De-dupe a basename within `dir` by appending ` (n)` before the extension. */
async function uniqueFilename(dir: string, name: string): Promise<string> {
  if (!(await pathExists(join(dir, name))) && name !== MANIFEST_NAME) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  let candidate = name;
  do {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  } while ((await pathExists(join(dir, candidate))) || candidate === MANIFEST_NAME);
  return candidate;
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
  const manifestPath = join(dir, MANIFEST_NAME);
  if (rows.length === 0) {
    await rm(manifestPath, { force: true }).catch(() => {});
    return;
  }
  const lines = [
    '# Attached files',
    '',
    'User-attached reference files for this task. Read any you need.',
    '',
    ...rows.map((r) => `- \`${r.filename}\`${r.description ? ` — ${r.description}` : ''}`),
    '',
  ];
  await writeFile(manifestPath, lines.join('\n'), 'utf8');
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

  const safeName = await uniqueFilename(dir, sanitizeAttachmentFilename(query.filename));
  const destPath = join(dir, safeName);
  const size = await streamToFileWithCap(body, destPath, maxBytes);
  await chmod(destPath, 0o644).catch(() => {});
  await chown(destPath, NODE_UID, NODE_GID).catch(() => {});

  const db = getDb();
  const inserted = await db
    .insert(schema.taskAttachments)
    .values({
      taskId,
      userId,
      filename: safeName,
      storedPath: destPath,
      sizeBytes: size,
      contentType: headerContentType(c.req.header('content-type')),
      description: query.description ?? null,
    })
    .returning();
  const row = inserted[0]!;

  await regenerateManifest(dir, taskId);
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

  const safeHeaderName = row.filename.replace(/["\r\n]/g, '_');
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

  await rm(row.storedPath, { force: true }).catch(() => {});
  const db = getDb();
  await db.delete(schema.taskAttachments).where(eq(schema.taskAttachments.id, attachmentId));
  await regenerateManifest(dirname(row.storedPath), taskId);
  return c.json({ ok: true });
});
