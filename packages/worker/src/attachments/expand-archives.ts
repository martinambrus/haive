import {
  chmodNoFollow,
  chownNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import path from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import {
  archiveStem,
  attachmentCopyName,
  ATTACHMENT_ARCHIVE_MAX_FILES,
  ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_PATH_LENGTH,
  ATTACHMENTS_MANIFEST_NAME,
  AttachmentPathError,
  detectAttachmentArchiveFormat,
  isReservedAttachmentName,
  logger,
  renderAttachmentsManifest,
  reserveAttachmentDirs,
  sanitizeAttachmentPath,
  splitAttachmentPath,
  splitAttachmentStoredPath,
} from '@haive/shared';
import { extractArchive } from '../repo/clone.js';
import { collapseToLine } from '../step-engine/steps/_untrusted-repo.js';

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

/** A note is stored once and shown to people and agents for the life of the task, so it is kept to
 *  what they can use. Member names are the archive's to choose and unbounded, and a failure can
 *  quote a tool's whole stderr. */
export const EXPANSION_ERROR_CHARS = 300;
const EXPANSION_NOTE_CHARS = 1000;
const PATH_DROP_NAMES = 3;
const PATH_DROP_NAME_CHARS = 80;

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The line of an expansion failure worth keeping: the first non-empty one, with the repository's
 *  host path taken out. An extractor reports `<tool> failed (exit N): <stderr>`, which is usually
 *  several lines, and a containment refusal names the anchor itself — neither belongs in a note a
 *  person reads in the UI and every agent is handed. */
export function expansionErrorLine(err: unknown, anchor: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const line =
    message
      .split(/[\r\n\u2028\u2029]/)
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return cap(
    collapseToLine(line.split(`${anchor}/`).join('').split(anchor).join('the repository')),
    EXPANSION_ERROR_CHARS,
  );
}

/** Members whose path cannot be stored under the attachment path rules (too deep or too long),
 *  named the way `describeDrops` names the ones extraction refused. */
function describePathDrops(rels: string[]): string | null {
  if (rels.length === 0) return null;
  // Collapsed before the cap: tar keeps a member name's bytes, newlines included.
  const shown = rels
    .slice(0, PATH_DROP_NAMES)
    .map((r) => cap(collapseToLine(r), PATH_DROP_NAME_CHARS));
  const more = rels.length > shown.length ? ` and ${rels.length - shown.length} more` : '';
  return `${rels.length} archive member(s) were not extracted (path too long or too deep to store): ${shown.join(', ')}${more}`;
}

interface WalkedFile {
  /** Path relative to the extraction root, with `/` separators. */
  rel: string;
  size: number;
}

/** Every REGULAR file under `baseRel`. Symlinks, devices and fifos are dropped
 *  rather than followed: an archive is untrusted input, and a symlink is how one
 *  reaches out of the directory it was extracted into. Directories are implied by
 *  the paths and recreated at the destination.
 *
 *  TWO rels are tracked on purpose. `baseRel` plus the walk position is what the
 *  primitives walk from the repository root — the extraction directory sits under
 *  `.haive/`, which the sandbox mounts read-write, so neither it nor the uploads dir
 *  above it can be the anchor — while a `WalkedFile.rel` stays relative to the
 *  extraction root, because that is what places the file at the destination. */
async function walkRegularFiles(
  anchor: string,
  baseRel: string,
  rel = '',
): Promise<{ files: WalkedFile[]; skipped: number }> {
  const entries = await readdirNoFollow(anchor, rel === '' ? baseRel : `${baseRel}/${rel}`);
  // Absent or refused: the extraction tree should be there, so count it rather than
  // throwing — the caller already reports what the walk could not take.
  if (entries === null) return { files: [], skipped: 1 };
  const files: WalkedFile[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    // lstat, not the dirent alone: what matters is that the entry is not a
    // symlink, and that is the question lstat answers about the entry itself.
    const st = await lstatNoFollow(anchor, `${baseRel}/${childRel}`);
    if (!st) {
      skipped += 1;
      continue;
    }
    if (st.kind === 'directory') {
      const nested = await walkRegularFiles(anchor, baseRel, childRel);
      files.push(...nested.files);
      skipped += nested.skipped;
      continue;
    }
    if (st.kind !== 'file') {
      skipped += 1;
      continue;
    }
    files.push({ rel: childRel, size: st.stats.size });
  }
  return { files, skipped };
}

/** A directory name for the archive's contents that is not already taken. Mirrors
 *  the api's per-directory de-dupe, so an archive uploaded twice lands as `spec/`
 *  and `spec (2)/` rather than merging into one tree. A name a generated file owns
 *  counts as taken too: `_PLAN_INPUTS.md.zip` expanded into a FOLDER named
 *  `_PLAN_INPUTS.md` would stop the plan-inputs index from ever being written. */
async function uniqueDirName(anchor: string, uploadsRel: string, stem: string): Promise<string> {
  const base = sanitizeAttachmentPath(stem).split('/').pop() || 'archive';
  let candidate = base;
  let n = 1;
  // A LINK at that name counts as TAKEN, which is the point: an occupied name is not free
  // space, and the `stat` this replaced would have followed it to decide.
  while (
    isReservedAttachmentName(candidate, true) ||
    (await lstatNoFollow(anchor, `${uploadsRel}/${candidate}`)) !== null
  ) {
    n += 1;
    candidate = attachmentCopyName(base, n, false);
  }
  return candidate;
}

/**
 * Where each of one archive's members is placed. The destination directory is brand new, so nothing
 * but the archive's own members can be in it, and they share one name space per folder:
 *
 * - two FILES that sanitise to one name (`a?.md` and `a*.md` are both `a_.md`) get ` (n)`, or the
 *   second would overwrite the first while both rows pointed at it;
 * - a FILE and a FOLDER that end up with one name get the same treatment. That happens when a
 *   reserved folder is renamed `<name> (2)` beside a member already called that, or when `a?/` and
 *   `a*` both sanitise to `a_` — and one of the two then could not be placed at all, which failed the
 *   expansion part-way. The folder keeps one placement for every member inside it.
 *
 * A member named like a sidecar is renamed, never dropped: `00-plan-inputs` writes
 * `<doc>.extracted.md` beside a document and would overwrite it. Members never sit at the uploads
 * root, so only the sidecar half of the reserved names applies here.
 */
function memberLayout(): (relPath: string) => string {
  const files = new Set<string>();
  const folders = new Set<string>();
  /** A folder as the member paths name it, to where it was placed. */
  const placedFolder = new Map<string, string>();
  const fileFree = (candidate: string): boolean =>
    !files.has(candidate) &&
    !folders.has(candidate) &&
    !isReservedAttachmentName(splitAttachmentPath(candidate).base, false);

  return (relPath) => {
    const segments = relPath.split('/');
    const leaf = segments.pop()!;
    let named = '';
    let parent = '';
    for (const segment of segments) {
      named = named === '' ? segment : `${named}/${segment}`;
      let placed = placedFolder.get(named);
      if (placed === undefined) {
        const within = parent === '' ? '' : `${parent}/`;
        placed = `${within}${segment}`;
        for (let n = 2; files.has(placed); n += 1) {
          placed = `${within}${attachmentCopyName(segment, n, false)}`;
        }
        placedFolder.set(named, placed);
        folders.add(placed);
      }
      parent = placed;
    }
    const within = parent === '' ? '' : `${parent}/`;
    let candidate = `${within}${leaf}`;
    for (let n = 2; !fileFree(candidate); n += 1) {
      candidate = `${within}${attachmentCopyName(leaf, n, true)}`;
    }
    // Numbering only lengthens a path, so it is held to the limit the member already met.
    if (candidate.length > ATTACHMENT_MAX_PATH_LENGTH) {
      throw new AttachmentPathError(`archive member "${relPath}" is too long once it is de-duped`);
    }
    files.add(candidate);
    return candidate;
  };
}

async function harmonize(anchor: string, rel: string, mode: number): Promise<void> {
  await chownNoFollow(anchor, rel, { uid: NODE_UID, gid: NODE_GID }).catch(() => {});
  await chmodNoFollow(anchor, rel, mode).catch(() => {});
}

/** Rewrite `_ATTACHMENTS.md` from the task's rows. The api owns this file on
 *  upload and delete; expansion is the third writer, and a prompt that tells every
 *  agent to read it must not point at an index missing the files just added. */
async function rewriteManifest(
  db: Database,
  taskId: string,
  anchor: string,
  uploadsRel: string,
): Promise<void> {
  const rows = await db.query.taskAttachments.findMany({
    where: eq(schema.taskAttachments.taskId, taskId),
    orderBy: asc(schema.taskAttachments.createdAt),
    columns: { filename: true, description: true },
  });
  const manifestRel = `${uploadsRel}/${ATTACHMENTS_MANIFEST_NAME}`;
  const body = renderAttachmentsManifest(rows);
  if (body === null) {
    await removeNoFollow(anchor, manifestRel).catch(() => {});
    return;
  }
  // Replace-atomic, and owned by the sandbox uid: every agent is told to read this index, so a
  // reader must see the old one or the new one and never a partial write.
  await writeFileNoFollow(anchor, manifestRel, body, { fileMode: 0o644 });
  await harmonize(anchor, manifestRel, 0o644);
}

/** Move one extracted file to its place under the uploads dir, creating the
 *  directories it needs. Returns the relative path it now lives at. */
async function placeFile(
  anchor: string,
  uploadsRel: string,
  relPath: string,
  fromRel: string,
): Promise<string> {
  const destRel = `${uploadsRel}/${relPath}`;
  // `createParents` does the `mkdir -p`, refusing a link in the chain rather than creating below it.
  // Ownership is NOT passed here: it is best-effort in this module (the `harmonize` calls below), and
  // handing it to the primitive makes it strict — which is EPERM for any worker that is not root,
  // as CI is. Chowning to uid 1000 is a courtesy for the sandbox, never a precondition for placing
  // the file.
  await renameNoFollow(anchor, fromRel, destRel, { createParents: true });
  const dirRel = destRel.slice(0, destRel.lastIndexOf('/'));
  await harmonize(anchor, dirRel, 0o755);
  await harmonize(anchor, destRel, 0o644);
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

  // Derived from the row rather than from the task's repository: the row says where its own bytes
  // are, so this needs no repo lookup and cannot write the expanded tree somewhere the originals
  // are not. The ANCHOR is the repository root, recovered by removing the suffix the api wrote —
  // the uploads dir itself sits under `.haive/`, which the sandbox mounts read-write, so it can
  // never be one. A row that does not have that shape is refused rather than expanded from a
  // guessed root.
  const split = splitAttachmentStoredPath(archives[0]!, taskId);
  if (!split) {
    log.warn({ taskId, archive: archives[0]!.filename }, 'unrecognised attachment path layout');
    return EMPTY;
  }
  const { anchor, uploadsRel } = split;
  const uploadsDir = path.join(anchor, uploadsRel);

  for (const archive of archives) {
    const format = detectAttachmentArchiveFormat(archive.filename)!;
    // A leading dot, so it can never collide with an attachment: the path sanitiser strips leading
    // dots from every segment.
    //
    // This stays INSIDE the uploads dir on purpose, even though the plan proposed moving it to the
    // extraction stage. `extractArchive` now stages privately beside its own destination and swaps
    // the finished tree in, so this directory is no longer where untrusted members are unpacked —
    // it only ever receives an already-validated tree. Moving it out would buy nothing and would
    // put the expansion's working set on a different filesystem from the attachments it feeds,
    // turning every `placeFile` rename into a cross-device copy.
    const tmp = path.join(uploadsDir, `.expanding-${archive.id}`);
    // The same directory as a rel, which is what everything except `extractArchive` wants: that
    // takes an absolute destination, while the walk, the placement source and the cleanup are all
    // anchored on the repository root.
    const tmpRel = `${uploadsRel}/.expanding-${archive.id}`;
    let note: string | null = null;
    let added = 0;
    try {
      // Split PER ROW rather than reusing the first archive's anchor with a composed rel: a row
      // whose stored path is not the layout the api writes is then reported as missing instead of
      // being probed at a guessed path — the same refusal the split above makes for the batch.
      const rowSplit = splitAttachmentStoredPath(archive, taskId);
      const onDisk = rowSplit ? await lstatNoFollow(rowSplit.anchor, rowSplit.rel) : null;
      if (onDisk?.kind !== 'file') {
        note = 'the archive file is missing from the task workspace';
      } else {
        // The report is the extraction's own account of what it would not write — symlinks, device
        // nodes, setuid files. It MUST be folded into the note below: those members used to be
        // counted by `walkRegularFiles` as `skipped`, and now they are gone before that walk runs,
        // so without this the drop would happen with nothing said about it.
        const report = await extractArchive(archive.storedPath, format, tmp);
        const { files, skipped } = await walkRegularFiles(anchor, tmpRel);
        const dropNote = report.note;
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
          const dirName = await uniqueDirName(anchor, uploadsRel, archiveStem(archive.filename));
          const place = memberLayout();
          const pathDropped: string[] = [];
          for (const file of files) {
            let relPath: string;
            try {
              relPath = place(
                reserveAttachmentDirs(sanitizeAttachmentPath(`${dirName}/${file.rel}`)),
              );
            } catch (err) {
              // The same rules the api enforces on an upload. A member that cannot be
              // expressed as a safe relative path is dropped, and named in the note below.
              if (!(err instanceof AttachmentPathError)) throw err;
              log.warn({ member: file.rel, archive: archive.filename }, 'dropped archive member');
              pathDropped.push(file.rel);
              continue;
            }
            const stored = await placeFile(anchor, uploadsRel, relPath, `${tmpRel}/${file.rel}`);
            try {
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
            } catch (err) {
              // A delete removes what ROWS name, so a placed file with none would outlive the
              // archive's delete, still mounted in the sandbox. Take it back before failing.
              await removeNoFollow(anchor, `${uploadsRel}/${stored}`).catch(() => {});
              throw err;
            }
            added += 1;
          }
          // Both halves are reported: what extraction dropped, and anything the walk still skipped
          // (an entry that vanished between the two, say). Joined rather than one overwriting the
          // other, because they describe different sets.
          const walkNote =
            skipped > 0
              ? `${skipped} entr(y/ies) were skipped: only regular files are extracted (no symlinks or devices)`
              : null;
          note =
            [dropNote, walkNote, describePathDrops(pathDropped)]
              .filter((n) => n !== null)
              .join('; ') || null;
        }
      }
    } catch (err) {
      note = `could not be expanded: ${expansionErrorLine(err, anchor)}`;
      log.warn({ err, taskId, archive: archive.filename }, 'archive expansion failed');
    } finally {
      await removeNoFollow(anchor, `${uploadsRel}/.expanding-${archive.id}`, {
        recursive: true,
      }).catch(() => {});
    }

    // Stamped whatever happened. Without it a failed or capped archive is retried
    // on every step for the life of the task, each time paying a full extraction.
    // ONE line whatever produced it — extraction's own drop note names members raw too — so the
    // stored note is what AGENTS.md promises it is, and not only what a prompt makes of it.
    if (note !== null) note = cap(collapseToLine(note), EXPANSION_NOTE_CHARS);
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
    await rewriteManifest(db, taskId, anchor, uploadsRel).catch((err: unknown) => {
      log.warn({ err, taskId }, 'could not rewrite the attachments manifest after expansion');
    });
  }
  log.info(
    { taskId, expanded: result.expanded, filesAdded: result.filesAdded },
    'expanded task archives',
  );
  return result;
}
