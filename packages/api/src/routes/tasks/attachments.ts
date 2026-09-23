import { randomUUID } from 'node:crypto';
import { type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { isLockNotAvailable, schema, withTaskAttachmentsLock } from '@haive/database';
import {
  attachmentCopyName,
  AttachmentPathError,
  CONFIG_KEYS,
  configService,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  isReadOnlyLocalRepo,
  isReservedAttachmentName,
  reserveAttachmentDirs,
  sanitizeAttachmentPath,
  splitAttachmentPath,
  splitAttachmentStoredPath,
  taskUploadsRel,
  uploadTaskAttachmentQuerySchema,
} from '@haive/shared';
import {
  chmodNoFollow,
  chownNoFollow,
  ensureDirNoFollow,
  isPathContainmentError,
  openFileNoFollow,
  removeNoFollow,
} from '@haive/shared/fs-safe';
import {
  pruneAfter,
  removeExpansionStagings,
  removeFiles,
  rewriteAttachmentsManifest,
  settleExpansionAttempts,
} from '@haive/shared/attachments-fs';
import { attachmentRemovalPlan } from '../../lib/attachment-removal.js';
import { containmentHttpError } from '../../lib/fs-http.js';
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

/** Resolve the task's on-disk uploads dir, enforcing ownership + a writable
 *  volume-backed repo. Throws 404/409 with an actionable message otherwise.
 *
 *  Returns the containment `anchor` alongside it: the repository ROOT, which is the only trusted
 *  directory here. The uploads dir itself lives under `.haive/`, which the cli-exec sandbox mounts
 *  read-write, so every component below the anchor has to be walked rather than joined. */
async function resolveTaskUploadsDir(
  taskId: string,
  userId: string,
): Promise<{ dir: string; anchor: string; rel: string }> {
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
  const rel = taskUploadsRel(taskId);
  return { dir: join(repo.storagePath, rel), anchor: repo.storagePath, rel };
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
    expandedAt: row.expandedAt?.toISOString() ?? null,
    expansionNote: row.expansionNote,
    expandedFromId: row.expandedFromId,
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

/** `safeAttachmentPath` for a name an upload is about to CREATE: a folder a generated file owns is
 *  renamed as well (`reserveAttachmentDirs`), and a path that rename makes too long is a 400 like
 *  any other. Not for a delete prefix, which has to name a legacy folder by what it is really called. */
function safeUploadPath(raw: string): string {
  try {
    return reserveAttachmentDirs(sanitizeAttachmentPath(raw));
  } catch (err) {
    if (err instanceof AttachmentPathError) throw new HttpError(400, err.message);
    throw err;
  }
}

/** How an upload answers a path the containment walk refused, instead of an unhandled 500.
 *  Not `containmentHttpError` as it stands: its fallback reports every other error as a 400 and
 *  its `not-directory` answer is "File not found", both wrong for a write. A file standing where
 *  the upload needs a folder is a conflict the user can resolve; any other refusal gets the read
 *  routes' answer; anything that is not a refusal (a full disk) stays a 500. */
function uploadPathError(err: unknown): never {
  if (isPathContainmentError(err, 'not-directory')) {
    throw new HttpError(409, 'A file already has the name of a folder in that path');
  }
  if (isPathContainmentError(err)) {
    containmentHttpError(err, 'Attachment path is outside the task workspace');
  }
  throw err;
}

/** A section that waited out `TASK_ATTACHMENTS_LOCK_TIMEOUT_MS` behind another writer answers 503:
 *  nothing was changed, and trying again is the whole remedy. Anything else is rethrown. */
function lockBusyError(err: unknown): never {
  if (isLockNotAvailable(err)) {
    throw new HttpError(503, 'Another change to this task’s attachments is in progress; try again');
  }
  throw err;
}

/** Make every level of `relDir` under the uploads root traversable + owned by the
 *  sandbox user. A folder upload creates directories the api never touched. */
async function ensureDirTree(anchor: string, uploadsRel: string, relDir: string): Promise<void> {
  if (relDir === '') return;
  const owner = { uid: NODE_UID, gid: NODE_GID };
  // The owner is applied by the best-effort pass below, not by the primitive: it is fatal there, and
  // an api that is not root cannot chown to the sandbox uid — 0755 is world-traversable regardless.
  await ensureDirNoFollow(anchor, `${uploadsRel}/${relDir}`, { mode: 0o755 });
  // `ensureDirNoFollow` applies owner and mode only to what IT created, on purpose — walking to a
  // deep path must not rewrite an existing directory's permissions. But a level an earlier upload
  // left root-owned still has to be handed over, so the existing ones are repaired explicitly.
  let cursor = uploadsRel;
  for (const segment of relDir.split('/')) {
    cursor = `${cursor}/${segment}`;
    await chownNoFollow(anchor, cursor, owner).catch(() => {});
    await chmodNoFollow(anchor, cursor, 0o755).catch(() => {});
  }
}

/** De-dupe within the file's OWN directory by appending ` (n)` before the
 *  extension, and create that directory. Per-directory because two folders'
 *  `README.md` are two documents, not a collision. A file name a generated file
 *  owns is skipped like a taken one (`isReservedAttachmentName`); a reserved
 *  FOLDER was already renamed by `safeUploadPath`. */
async function createUniqueAttachment(
  anchor: string,
  uploadsRel: string,
  relPath: string,
): Promise<{ rel: string; fh: FileHandle }> {
  const { dir: relDir, base } = splitAttachmentPath(relPath);
  await ensureDirTree(anchor, uploadsRel, relDir);
  const rel = (name: string): string => (relDir === '' ? name : `${relDir}/${name}`);

  // The name is CLAIMED by creating it, not by probing for it. The `access` probe this replaces
  // could pass and the name be taken before the write landed — and it reported a dangling link as
  // free, so the upload went wherever that link pointed.
  for (let n = 1; n <= 1000; n += 1) {
    const candidate = n === 1 ? base : attachmentCopyName(base, n, true);
    if (isReservedAttachmentName(candidate, relDir === '')) continue;
    try {
      const fh = await openFileNoFollow(
        anchor,
        `${uploadsRel}/${rel(candidate)}`,
        'create-exclusive',
        { fileMode: 0o644 },
      );
      // Best-effort, as the chown here has always been: an api that is not root cannot hand the
      // file to the sandbox uid, and 0644 is world-readable, so the upload must not fail over it.
      await chownNoFollow(anchor, `${uploadsRel}/${rel(candidate)}`, {
        uid: NODE_UID,
        gid: NODE_GID,
      }).catch(() => {});
      return { rel: rel(candidate), fh };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new HttpError(409, `too many attachments named like "${base}"`);
}

/**
 * Claim an upload's name under the task's attachments lock. A delete holds the same lock while it
 * removes files, deletes rows and prunes the folders they emptied, so it can neither prune the folder
 * this name is being created in nor take a file of that name between the two.
 *
 * The claim is kept OUTSIDE the section: the driver can reject the transaction while its callback is
 * still running (a lost connection), and a file created after that has to be found and taken back
 * rather than left on disk with no row.
 */
async function claimAttachmentName(
  taskId: string,
  anchor: string,
  uploadsRel: string,
  relPath: string,
): Promise<{ rel: string; fh: FileHandle }> {
  let claim = null as Promise<{ rel: string; fh: FileHandle }> | null;
  try {
    await withTaskAttachmentsLock(getDb(), taskId, async () => {
      claim = createUniqueAttachment(anchor, uploadsRel, relPath);
      await claim;
    });
    return await claim!;
  } catch (err) {
    const claimed = claim === null ? null : await claim.catch(() => null);
    if (claimed !== null) {
      await claimed.fh.close().catch(() => {});
      await removeNoFollow(anchor, `${uploadsRel}/${claimed.rel}`).catch(() => {});
    }
    return isLockNotAvailable(err) ? lockBusyError(err) : uploadPathError(err);
  }
}

/** Stream the request body to `destPath`, aborting + unlinking once the byte count
 *  exceeds `maxBytes` (413). Streaming keeps memory bounded regardless of the cap. */
async function streamToFileWithCap(
  body: ReadableStream<Uint8Array>,
  fh: FileHandle,
  maxBytes: number,
): Promise<number> {
  const nodeStream = Readable.fromWeb(body as never);
  // Streamed through the descriptor the caller already created and verified, so the bytes cannot
  // land anywhere but that inode. The caller owns cleanup on failure, since it owns the name.
  const writeStream = fh.createWriteStream();
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
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, `attachment write failed: ${(err as Error).message}`);
  }
  return total;
}

/** Make a freshly-created dir traversable + owned by the sandbox user. Best-effort
 *  (the api is root; failures are non-fatal since 0755/0644 are world-readable). */
async function ensureUploadsDir(anchor: string, uploadsRel: string): Promise<void> {
  const owner = { uid: NODE_UID, gid: NODE_GID };
  await ensureDirNoFollow(anchor, uploadsRel, { mode: 0o755 });
  // `.haive/task-uploads/` and the task dir both, because either can predate this upload and be
  // root-owned — an unwritable parent defeats a writable child.
  const parentRel = uploadsRel.slice(0, uploadsRel.lastIndexOf('/'));
  for (const rel of [parentRel, uploadsRel]) {
    await chownNoFollow(anchor, rel, owner).catch(() => {});
    await chmodNoFollow(anchor, rel, 0o755).catch(() => {});
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
  anchor: string;
  uploadsRel: string;
  destPath: string;
  filename: string;
  taskId: string;
  userId: string;
  sizeBytes: number;
  contentType: string | null;
  description: string | null;
}) {
  // No chmod/chown here any more: the file was created through `create-exclusive`, which applied
  // the mode and owner to the descriptor before any bytes were written — so there is no window in
  // which the agent's file exists with the wrong owner.
  // The id is chosen here so a failed insert can be told from one whose answer was lost.
  const id = randomUUID();
  let row: typeof schema.taskAttachments.$inferSelect | undefined;
  try {
    [row] = await getDb()
      .insert(schema.taskAttachments)
      .values({
        id,
        taskId: args.taskId,
        userId: args.userId,
        filename: args.filename,
        storedPath: args.destPath,
        sizeBytes: args.sizeBytes,
        contentType: args.contentType,
        description: args.description,
      })
      .returning();
  } catch (err) {
    // A file with no row is invisible to every delete, and stays mounted into the sandbox. But the
    // insert can have committed with only its answer lost, and then the file is the attachment:
    // it is taken back only once a second look finds no row, and kept when that look fails too.
    const found = await getDb()
      .query.taskAttachments.findFirst({ where: eq(schema.taskAttachments.id, id) })
      .catch(() => null);
    if (found === undefined) {
      await removeNoFollow(args.anchor, `${args.uploadsRel}/${args.filename}`).catch(() => {});
    }
    if (!found) throw err;
    row = found;
  }

  await rewriteAttachmentsManifest(getDb(), args.taskId, args.anchor, args.uploadsRel);
  return row!;
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
  const { dir, anchor, rel: uploadsRel } = await resolveTaskUploadsDir(args.taskId, args.userId);
  await ensureUploadsDir(anchor, uploadsRel);

  const { rel: safeName, fh } = await claimAttachmentName(
    args.taskId,
    anchor,
    uploadsRel,
    safeUploadPath(args.filename),
  );
  const bytes = typeof args.content === 'string' ? Buffer.from(args.content, 'utf8') : args.content;
  try {
    let written = 0;
    while (written < bytes.length) {
      const res = await fh.write(bytes, written, bytes.length - written, written);
      written += res.bytesWritten;
    }
  } catch (err) {
    await fh.close().catch(() => {});
    await removeNoFollow(anchor, `${uploadsRel}/${safeName}`).catch(() => {});
    throw err;
  }
  await fh.close();
  const destPath = join(dir, safeName);

  return finalizeAttachment({
    anchor,
    uploadsRel,
    destPath,
    filename: safeName,
    taskId: args.taskId,
    userId: args.userId,
    sizeBytes: bytes.length,
    contentType: args.contentType ?? null,
    description: args.description ?? null,
  });
}

attachmentRoutes.post('/:id/attachments', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const { dir, anchor, rel: uploadsRel } = await resolveTaskUploadsDir(taskId, userId);

  const query = uploadTaskAttachmentQuerySchema.parse({
    filename: c.req.query('filename'),
    description: c.req.query('description'),
  });
  // Checked before anything is created, so a refused name leaves no directory behind.
  const relPath = safeUploadPath(query.filename);

  const body = c.req.raw.body;
  if (!body) throw new HttpError(400, 'request body is empty');

  const maxBytes = await configService.getNumber(
    CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES,
    DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  );

  await ensureUploadsDir(anchor, uploadsRel).catch(uploadPathError);

  const { rel: safeName, fh } = await claimAttachmentName(taskId, anchor, uploadsRel, relPath);
  const destPath = join(dir, safeName);
  let size: number;
  try {
    size = await streamToFileWithCap(body, fh, maxBytes);
  } catch (err) {
    // The name was claimed by creating it, so an aborted or over-cap upload has to unclaim it —
    // otherwise the next attempt collides with our own empty file.
    await fh.close().catch(() => {});
    await removeNoFollow(anchor, `${uploadsRel}/${safeName}`).catch(() => {});
    throw err;
  }
  await fh.close().catch(() => {});

  const row = await finalizeAttachment({
    anchor,
    uploadsRel,
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

  // The uploads dir sits at `<storagePath>/.haive/task-uploads/<taskId>`, and `.haive` is
  // sandbox-writable, so neither it nor the uploads dir may be the anchor: the repository root is.
  // Derived from the row's own `storedPath` by removing the suffix the api wrote, which also
  // refuses a legacy row whose path does not have that shape rather than guessing an anchor.
  const suffix = `/${join('.haive', 'task-uploads', taskId, row.filename)}`;
  if (!row.storedPath.endsWith(suffix)) {
    throw new HttpError(404, 'Attachment file is missing on disk');
  }
  const anchor = row.storedPath.slice(0, -suffix.length);
  const rel = join('.haive', 'task-uploads', taskId, row.filename);

  const fh = await openFileNoFollow(anchor, rel, 'read', { strict: true }).catch((err: unknown) =>
    containmentHttpError(err, 'Attachment path is outside the task workspace'),
  );
  if (fh === null) throw new HttpError(404, 'Attachment file is missing on disk');
  const size = (await fh.stat()).size;

  // The BASENAME: `filename` may be a relative path now, and a header carrying
  // `docs/api/spec.md` names a directory the downloader does not have.
  const safeHeaderName = splitAttachmentPath(row.filename).base.replace(/["\r\n]/g, '_');
  c.header('Content-Type', row.contentType ?? 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${safeHeaderName}"`);
  c.header('Content-Length', String(size));
  c.header('Cache-Control', 'no-store');
  return c.body(Readable.toWeb(fh.createReadStream()) as never);
});

attachmentRoutes.delete('/:id/attachments/:attachmentId', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const attachmentId = c.req.param('attachmentId');
  await requireOwnedTask(taskId, userId);
  const row = await findAttachment(taskId, userId, attachmentId);

  const db = getDb();
  // The repository ROOT, recovered from the row's own stored path. The uploads dir cannot be the
  // anchor: it lives under `.haive/`, which the cli-exec sandbox mounts read-write. A row whose
  // path does not have the shape the api wrote is refused rather than deleted from a guessed root.
  const split = splitAttachmentStoredPath(row, taskId);
  if (!split) throw new HttpError(409, 'Attachment path is not in a recognised layout');
  const { anchor, uploadsRel } = split;

  // One section under the task's attachments lock, from reading the rows to rewriting the
  // manifest: the worker writes a sidecar only under the same lock and only while its row exists,
  // so no sidecar can land between the files going and the rows going and outlive both.
  const settled = await withTaskAttachmentsLock(db, taskId, async (tx) => {
    // Besides its own file, what the FK cannot reach: an archive's members (their ROWS cascade on
    // the delete below) and the extracted-text sidecars. Both stay bind-mounted into the sandbox,
    // so an agent would keep reading files the user believes they removed. And the archive itself,
    // when this was the last file extracted from it.
    const rows = await tx.query.taskAttachments.findMany({
      where: and(
        eq(schema.taskAttachments.taskId, taskId),
        eq(schema.taskAttachments.userId, userId),
      ),
      columns: { id: true, filename: true, expandedFromId: true },
    });
    const plan = attachmentRemovalPlan(new Set([attachmentId]), rows);
    await removeFiles(anchor, uploadsRel, plan.files);
    await tx.delete(schema.taskAttachments).where(inArray(schema.taskAttachments.id, plan.ids));
    // An expansion of a removed archive the worker was interrupted in: with the archive's row gone,
    // no later call would know it had anything to take back.
    const attempts = await settleExpansionAttempts(
      tx,
      taskId,
      anchor,
      uploadsRel,
      new Set(plan.ids),
    );
    await pruneAfter(anchor, uploadsRel, plan.files);
    await rewriteAttachmentsManifest(tx, taskId, anchor, uploadsRel);
    return attempts;
  }).catch(lockBusyError);
  // Outside the section: a staging dir can hold a whole extracted archive.
  await removeExpansionStagings(anchor, uploadsRel, settled);
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

  // The same one section as the single delete, and for the same reason.
  const done = await withTaskAttachmentsLock(getDb(), taskId, async (tx) => {
    const rows = await tx.query.taskAttachments.findMany({
      where: and(
        eq(schema.taskAttachments.taskId, taskId),
        eq(schema.taskAttachments.userId, userId),
      ),
    });
    // Filtered here rather than with a SQL LIKE: `_` is a LIKE wildcard AND a legal
    // filename character, so `docs_v2/a.md` would match a `docs/v2` prefix.
    const marked = rows.filter((r) => r.filename.startsWith(`${prefix}/`));
    if (marked.length === 0) throw new HttpError(404, `No attachments under "${prefix}/"`);

    const split = splitAttachmentStoredPath(marked[0]!, taskId);
    if (!split) throw new HttpError(409, 'Attachment path is not in a recognised layout');
    const { anchor, uploadsRel } = split;
    // File by file, and the folder goes by pruning once it is empty: a recursive removal would also
    // take a file uploaded into it after `rows` was read. The list includes the sidecars and the
    // members of any archive in the folder, whose tree sits at the uploads ROOT, not under the
    // folder.
    const plan = attachmentRemovalPlan(new Set(marked.map((r) => r.id)), rows);
    await removeFiles(anchor, uploadsRel, plan.files);
    await tx.delete(schema.taskAttachments).where(inArray(schema.taskAttachments.id, plan.ids));
    const settled = await settleExpansionAttempts(
      tx,
      taskId,
      anchor,
      uploadsRel,
      new Set(plan.ids),
    );
    await pruneAfter(anchor, uploadsRel, plan.files);
    await rewriteAttachmentsManifest(tx, taskId, anchor, uploadsRel);
    return { removed: plan.ids.length, anchor, uploadsRel, settled };
  }).catch(lockBusyError);
  // Outside the section: a staging dir can hold a whole extracted archive.
  await removeExpansionStagings(done.anchor, done.uploadsRel, done.settled);
  return c.json({ ok: true, removed: done.removed });
});
