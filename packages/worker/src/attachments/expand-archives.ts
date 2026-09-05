import { chmod, chown, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import {
  archiveStem,
  ATTACHMENT_ARCHIVE_MAX_FILES,
  ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES,
  ATTACHMENTS_MANIFEST_NAME,
  AttachmentPathError,
  attachmentUploadsRoot,
  detectAttachmentArchiveFormat,
  logger,
  renderAttachmentsManifest,
  sanitizeAttachmentPath,
} from '@haive/shared';
import { extractArchive } from '../repo/clone.js';

/**
 * An uploaded archive becomes the tree it contains.
 *
 * A `.zip` reaching an agent as a single opaque blob is a document nobody can
 * read: `classifyPlanInput` calls it `binary`, no text form is written, and the
 * plan index tells the agent there is nothing in it. Expanding it produces
 * exactly the rows a FOLDER upload would have produced — one per file, each
 * named by its relative path — so everything downstream (the manifest, the plan
 * inputs step, the coverage scan, the prompt notice) needs no special case.
 *
 * Lazy on purpose: the api writes the bytes and this runs the first time a task
 * is about to read its attachments, which is where the tools live (`unzip` and
 * `tar` are in the worker image, not the api's) and where a slow expansion costs
 * an HTTP request nothing.
 *
 * Idempotent, cheap when there is nothing to do, and it NEVER throws — a task
 * must not fail because an archive could not be opened, since the original file
 * is still mounted and readable by whatever can open it.
 */

const log = logger.child({ module: 'attachment-archives' });
const NODE_UID = 1000;
const NODE_GID = 1000;

export interface ExpandArchivesResult {
  /** Archives processed by THIS call (0 on the common repeat path). */
  expanded: number;
  filesAdded: number;
  notes: { filename: string; note: string }[];
}

const EMPTY: ExpandArchivesResult = { expanded: 0, filesAdded: 0, notes: [] };

interface WalkedFile {
  /** Path relative to the extraction root, with `/` separators. */
  rel: string;
  size: number;
}

/** Every REGULAR file under `root`. Symlinks, devices and fifos are dropped
 *  rather than followed: an archive is untrusted input, and a symlink is how one
 *  reaches out of the directory it was extracted into. Directories are implied by
 *  the paths and recreated at the destination. */
async function walkRegularFiles(
  root: string,
  rel = '',
): Promise<{ files: WalkedFile[]; skipped: number }> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const files: WalkedFile[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    // lstat, not the dirent alone: what matters is that the entry is not a
    // symlink, and that is the question lstat answers about the entry itself.
    const st = await lstat(path.join(root, childRel)).catch(() => null);
    if (!st) {
      skipped += 1;
      continue;
    }
    if (st.isDirectory()) {
      const nested = await walkRegularFiles(root, childRel);
      files.push(...nested.files);
      skipped += nested.skipped;
      continue;
    }
    if (!st.isFile()) {
      skipped += 1;
      continue;
    }
    files.push({ rel: childRel, size: st.size });
  }
  return { files, skipped };
}

/** A directory name for the archive's contents that is not already taken. Mirrors
 *  the api's per-directory de-dupe, so an archive uploaded twice lands as `spec/`
 *  and `spec (2)/` rather than merging into one tree. */
async function uniqueDirName(uploadsDir: string, stem: string): Promise<string> {
  const base = sanitizeAttachmentPath(stem).split('/').pop() || 'archive';
  let candidate = base;
  let n = 1;
  while (await stat(path.join(uploadsDir, candidate)).catch(() => null)) {
    n += 1;
    candidate = `${base} (${n})`;
  }
  return candidate;
}

/** `relPath` if free, else the same name with ` (n)` before the extension. The
 *  set is per-archive: the destination directory is brand new, so nothing else
 *  can be in it. */
function uniqueWithin(taken: Set<string>, relPath: string): string {
  if (!taken.has(relPath)) {
    taken.add(relPath);
    return relPath;
  }
  const dot = relPath.lastIndexOf('.');
  const cut = relPath.lastIndexOf('/');
  const hasExt = dot > cut + 1;
  const stem = hasExt ? relPath.slice(0, dot) : relPath;
  const ext = hasExt ? relPath.slice(dot) : '';
  let n = 1;
  let candidate = relPath;
  do {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  } while (taken.has(candidate));
  taken.add(candidate);
  return candidate;
}

async function harmonize(target: string, mode: number): Promise<void> {
  await chmod(target, mode).catch(() => {});
  await chown(target, NODE_UID, NODE_GID).catch(() => {});
}

/** Rewrite `_ATTACHMENTS.md` from the task's rows. The api owns this file on
 *  upload and delete; expansion is the third writer, and a prompt that tells every
 *  agent to read it must not point at an index missing the files just added. */
async function rewriteManifest(db: Database, taskId: string, uploadsDir: string): Promise<void> {
  const rows = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.taskId, taskId),
    orderBy: asc(schema.taskAttachments.createdAt),
    columns: { filename: true, description: true },
  });
  const manifestPath = path.join(uploadsDir, ATTACHMENTS_MANIFEST_NAME);
  const body = renderAttachmentsManifest(rows);
  if (body === null) {
    await rm(manifestPath, { force: true }).catch(() => {});
    return;
  }
  await writeFile(manifestPath, body, 'utf8');
  await harmonize(manifestPath, 0o644);
}

/** Move one extracted file to its place under the uploads dir, creating the
 *  directories it needs. Returns the relative path it now lives at. */
async function placeFile(uploadsDir: string, relPath: string, from: string): Promise<string> {
  const dest = path.join(uploadsDir, relPath);
  const dir = path.dirname(dest);
  await mkdir(dir, { recursive: true });
  await harmonize(dir, 0o755);
  await rename(from, dest);
  await harmonize(dest, 0o644);
  return relPath;
}

/**
 * Expand every not-yet-expanded archive attached to `taskId`.
 *
 * All-or-nothing per archive: a cap breach or an unreadable archive records a
 * note and inserts nothing, because a partial tree is worse than none — nothing
 * downstream can tell which half of a specification it was given.
 */
export async function ensureArchivesExpanded(
  db: Database,
  taskId: string,
): Promise<ExpandArchivesResult> {
  let candidates: (typeof schema.taskAttachments.$inferSelect)[];
  try {
    candidates = await db.query.taskAttachments.findMany({
      where: and(
        eq(schema.taskAttachments.taskId, taskId),
        isNull(schema.taskAttachments.expandedAt),
        // A row that came OUT of an archive is never itself expanded. That is
        // what makes "nested archives are not recursed" structural rather than a
        // depth counter, and it is why an archive inside an archive stays a file.
        isNull(schema.taskAttachments.expandedFromId),
      ),
      orderBy: asc(schema.taskAttachments.createdAt),
    });
  } catch (err) {
    log.warn({ err, taskId }, 'could not load attachments for archive expansion');
    return EMPTY;
  }

  const archives = candidates.filter((row) => detectAttachmentArchiveFormat(row.filename) !== null);
  if (archives.length === 0) return EMPTY;

  const result: ExpandArchivesResult = { expanded: 0, filesAdded: 0, notes: [] };

  // Taken from the row rather than from the task's repository: the row says where
  // its own bytes are, so this needs no repo lookup and cannot write the expanded
  // tree somewhere the originals are not.
  const uploadsDir = attachmentUploadsRoot(archives[0]!);

  for (const archive of archives) {
    const format = detectAttachmentArchiveFormat(archive.filename)!;
    // A leading dot, so it can never collide with an attachment: the path
    // sanitiser strips leading dots from every segment.
    const tmp = path.join(uploadsDir, `.expanding-${archive.id}`);
    let note: string | null = null;
    let added = 0;
    try {
      const onDisk = await stat(archive.storedPath).catch(() => null);
      if (!onDisk?.isFile()) {
        note = 'the archive file is missing from the task workspace';
      } else {
        await extractArchive(archive.storedPath, format, tmp);
        const { files, skipped } = await walkRegularFiles(tmp);
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

        // Measured AFTER extraction, deliberately. The alternative is to trust the
        // archive's own declared sizes, which means parsing `unzip -Z`/`tar -tv`
        // human-facing output — and a bomb is exactly the input that lies in it.
        // The temp tree is removed below either way, so nothing is left behind.
        if (files.length === 0) {
          note = 'the archive contains no readable files';
        } else if (files.length > ATTACHMENT_ARCHIVE_MAX_FILES) {
          note = `contains ${files.length} files, over the ${ATTACHMENT_ARCHIVE_MAX_FILES} limit — nothing was extracted; attach the parts you need`;
        } else if (totalBytes > ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES) {
          note = `expands to ${Math.round(totalBytes / 1024 / 1024)} MB, over the ${Math.round(ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES / 1024 / 1024)} MB limit — nothing was extracted`;
        } else {
          const dirName = await uniqueDirName(uploadsDir, archiveStem(archive.filename));
          // Two members can sanitise to ONE name (`a?.md` and `a*.md` both become
          // `a_.md`), and the second would then overwrite the first while both
          // rows pointed at it. Same ` (n)` de-dupe the api applies to uploads.
          const taken = new Set<string>();
          for (const file of files) {
            let relPath: string;
            try {
              relPath = uniqueWithin(taken, sanitizeAttachmentPath(`${dirName}/${file.rel}`));
            } catch (err) {
              // The same rules the api enforces on an upload. A member that
              // cannot be expressed as a safe relative path is dropped, named.
              if (!(err instanceof AttachmentPathError)) throw err;
              log.warn({ member: file.rel, archive: archive.filename }, 'dropped archive member');
              continue;
            }
            const stored = await placeFile(uploadsDir, relPath, path.join(tmp, file.rel));
            await db.insert(schema.taskAttachments).values({
              taskId,
              userId: archive.userId,
              filename: stored,
              storedPath: path.join(uploadsDir, stored),
              sizeBytes: file.size,
              contentType: null,
              description: null,
              expandedFromId: archive.id,
            });
            added += 1;
          }
          if (skipped > 0) {
            note = `${skipped} entr(y/ies) were skipped: only regular files are extracted (no symlinks or devices)`;
          }
        }
      }
    } catch (err) {
      note = `could not be expanded: ${(err as Error).message}`;
      log.warn({ err, taskId, archive: archive.filename }, 'archive expansion failed');
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }

    // Stamped whatever happened. Without it a failed or capped archive is retried
    // on every step for the life of the task, each time paying a full extraction.
    await db
      .update(schema.taskAttachments)
      .set({ expandedAt: new Date(), expansionNote: note })
      .where(eq(schema.taskAttachments.id, archive.id))
      .catch((err: unknown) => {
        log.warn({ err, taskId, archive: archive.filename }, 'could not stamp archive expansion');
      });

    result.expanded += 1;
    result.filesAdded += added;
    if (note) result.notes.push({ filename: archive.filename, note });
  }

  if (result.filesAdded > 0) {
    await rewriteManifest(db, taskId, uploadsDir).catch((err: unknown) => {
      log.warn({ err, taskId }, 'could not rewrite the attachments manifest after expansion');
    });
  }
  log.info(
    { taskId, expanded: result.expanded, filesAdded: result.filesAdded },
    'expanded task archives',
  );
  return result;
}
