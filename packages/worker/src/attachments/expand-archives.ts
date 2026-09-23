import { randomUUID } from 'node:crypto';
import {
  applyTreeNoFollow,
  ensureDirNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import path from 'node:path';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  isLockNotAvailable,
  schema,
  withTaskAttachmentsLock,
  type Database,
  type DbTx,
} from '@haive/database';
import {
  archiveStem,
  attachmentCopyName,
  ATTACHMENT_ARCHIVE_MAX_FILES,
  ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_PATH_LENGTH,
  AttachmentPathError,
  detectAttachmentArchiveFormat,
  isReservedAttachmentName,
  logger,
  reserveAttachmentDirs,
  sanitizeAttachmentPath,
  splitAttachmentPath,
  splitAttachmentStoredPath,
} from '@haive/shared';
import {
  EXPANSION_INTENT_FILE,
  EXPANSION_STAGING_PREFIX,
  expansionAttemptArchiveId,
  pruneAfter,
  readExpansionIntent,
  removeFiles,
  rewriteAttachmentsManifest,
  settleExpansionAttempt,
  settleExpansionAttempts,
} from '@haive/shared/attachments-fs';
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
const SANDBOX_OWNER = { uid: 1000, gid: 1000 };

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

/* Each attempt at one archive works in its own `.expanding-<archiveId>-<nonce>` directory under the
 * uploads dir: `EXPANSION_STAGING_PREFIX`, with the rules for settling an interrupted attempt beside
 * it in `@haive/shared/attachments-fs`. The nonce is what lets two overlapping calls at one archive
 * each extract without the second moving the first's tree aside. */
/** How many folder names an expansion tries, the api's bound for a file name. */
const FOLDER_CANDIDATES = 1000;
const NO_FOLDER_NOTE =
  'could not be expanded: every folder name for its contents is taken or would make a path too long';

const cap = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const storedNote = (note: string): string => cap(collapseToLine(note), EXPANSION_NOTE_CHARS);

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

/** The folder names an archive's contents may take, in the order they are tried. Mirrors the api's
 *  per-directory de-dupe, so an archive uploaded twice lands as `spec/` and `spec (2)/` rather than
 *  merging into one tree. A name a generated file owns is never offered: `_PLAN_INPUTS.md.zip`
 *  expanded into a FOLDER named `_PLAN_INPUTS.md` would stop the plan-inputs index from ever being
 *  written. */
function folderCandidates(archiveFilename: string): string[] {
  const base = sanitizeAttachmentPath(archiveStem(archiveFilename)).split('/').pop() || 'archive';
  const names: string[] = [];
  for (let n = 1; names.length < FOLDER_CANDIDATES && n <= FOLDER_CANDIDATES * 2; n += 1) {
    const name = n === 1 ? base : attachmentCopyName(base, n, false);
    if (!isReservedAttachmentName(name, true)) names.push(name);
  }
  return names;
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

/** A tree built in the staging dir, ready to be moved into place whole. */
interface StagedTree {
  /** Member paths relative to the tree's root, which becomes the folder, with their sizes. */
  members: { rel: string; size: number }[];
  /** Folder names to try; the member paths were held to the length limit under the first. */
  folders: string[];
  longest: number;
  note: string | null;
}

const stagingRelOf = (uploadsRel: string, staging: string): string => `${uploadsRel}/${staging}`;

/**
 * Settle the attempts whose archive nothing will expand any more: deleted, or already stamped. The
 * rows are read again under the lock, because an archive attached after the caller read its
 * candidates has an attempt in flight that this must not touch.
 */
async function sweepStaleAttempts(
  db: Database,
  taskId: string,
  anchor: string,
  uploadsRel: string,
  candidateIds: ReadonlySet<string>,
): Promise<void> {
  const stale = ((await readdirNoFollow(anchor, uploadsRel)) ?? [])
    .map((entry) => entry.name)
    .filter((name) => {
      const id = expansionAttemptArchiveId(name);
      return id !== null && !candidateIds.has(id);
    });
  if (stale.length === 0) return;
  try {
    await withTaskAttachmentsLock(db, taskId, async (tx) => {
      const ids = [...new Set(stale.map((name) => expansionAttemptArchiveId(name)!))];
      const pending = new Set(
        (
          await tx.query.taskAttachments.findMany({
            where: and(
              eq(schema.taskAttachments.taskId, taskId),
              inArray(schema.taskAttachments.id, ids),
            ),
            columns: { id: true, expandedAt: true },
          })
        )
          .filter((row) => row.expandedAt === null)
          .map((row) => row.id),
      );
      for (const name of stale) {
        if (!pending.has(expansionAttemptArchiveId(name)!)) {
          await settleExpansionAttempt(tx, taskId, anchor, uploadsRel, name);
        }
      }
    });
  } catch (err) {
    log.warn({ err, taskId }, 'could not settle interrupted archive expansions');
  }
}

/** Mark an archive as expanded, only while nothing else has. True when this call did. */
async function stamp(tx: DbTx, archiveId: string, note: string | null): Promise<boolean> {
  const rows = await tx
    .update(schema.taskAttachments)
    .set({ expandedAt: new Date(), expansionNote: note })
    .where(and(eq(schema.taskAttachments.id, archiveId), isNull(schema.taskAttachments.expandedAt)))
    .returning({ id: schema.taskAttachments.id });
  return rows.length > 0;
}

/**
 * Record an archive that will not be expanded, and settle every attempt at it on the way — this one
 * included. Stamped whatever the reason, or a failed or capped archive is re-extracted on every step
 * for the life of the task. False when it was not this call that recorded it: already stamped,
 * deleted, or the lock could not be had, in which case the archive stays a candidate.
 */
async function stampNote(
  db: Database,
  taskId: string,
  anchor: string,
  uploadsRel: string,
  archiveId: string,
  note: string,
): Promise<boolean> {
  try {
    return await withTaskAttachmentsLock(db, taskId, async (tx) => {
      await settleExpansionAttempts(tx, taskId, anchor, uploadsRel, new Set([archiveId]));
      return stamp(tx, archiveId, note);
    });
  } catch (err) {
    log.warn({ err, taskId, archiveId }, 'could not stamp archive expansion');
    return false;
  }
}

/**
 * Extract one archive and build its tree in the staging dir, OUTSIDE the lock: extraction is the
 * slow part and runs as an unprivileged uid. Answers the note to stamp when there is nothing to
 * place.
 */
async function stageTree(
  anchor: string,
  stagingRel: string,
  archive: typeof schema.taskAttachments.$inferSelect,
  taskId: string,
): Promise<StagedTree | string> {
  // Split PER ROW rather than reusing the batch's anchor with a composed rel: a row whose stored path
  // is not the layout the api writes is then reported as missing instead of being probed at a
  // guessed path.
  const rowSplit = splitAttachmentStoredPath(archive, taskId);
  const onDisk = rowSplit ? await lstatNoFollow(rowSplit.anchor, rowSplit.rel) : null;
  if (onDisk?.kind !== 'file') return 'the archive file is missing from the task workspace';

  // 0711: extraction runs as uid 65534 (`clone.ts`), which has to TRAVERSE this to reach the stage
  // `extractArchive` makes inside it, and must not be able to list it.
  await ensureDirNoFollow(anchor, stagingRel, { mode: 0o711 });
  const rawRel = `${stagingRel}/raw`;
  // The report is the extraction's own account of what it would not write — symlinks, device nodes,
  // setuid files — and is folded into the note, since those members are gone before the walk runs.
  const report = await extractArchive(
    archive.storedPath,
    detectAttachmentArchiveFormat(archive.filename)!,
    path.join(anchor, rawRel),
  );
  const { files, skipped } = await walkRegularFiles(anchor, rawRel);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  // Measured AFTER extraction, deliberately. The alternative is to trust the archive's own declared
  // sizes, which means parsing `unzip -Z`/`tar -tv` human-facing output — and a bomb is exactly the
  // input that lies in it.
  if (files.length === 0) return 'the archive contains no readable files';
  if (files.length > ATTACHMENT_ARCHIVE_MAX_FILES) {
    return `contains ${files.length} files, over the ${ATTACHMENT_ARCHIVE_MAX_FILES} limit — nothing was extracted; attach the parts you need`;
  }
  if (totalBytes > ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES) {
    return `expands to ${Math.round(totalBytes / 1024 / 1024)} MB, over the ${Math.round(ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES / 1024 / 1024)} MB limit — nothing was extracted`;
  }

  const folders = folderCandidates(archive.filename);
  const first = folders[0]!;
  const place = memberLayout();
  const members: StagedTree['members'] = [];
  const pathDropped: string[] = [];
  for (const file of files) {
    let rel: string;
    try {
      // The same rules the api enforces on an upload, held against the first folder name so the
      // length limit is the one the placed path has to meet.
      rel = place(reserveAttachmentDirs(sanitizeAttachmentPath(`${first}/${file.rel}`))).slice(
        first.length + 1,
      );
    } catch (err) {
      // A member that cannot be expressed as a safe relative path is dropped, and named in the note.
      if (!(err instanceof AttachmentPathError)) throw err;
      log.warn({ member: file.rel, archive: archive.filename }, 'dropped archive member');
      pathDropped.push(file.rel);
      continue;
    }
    await renameNoFollow(anchor, `${rawRel}/${file.rel}`, `${stagingRel}/tree/${rel}`, {
      createParents: true,
    });
    members.push({ rel, size: file.size });
  }

  // Both halves are reported: what extraction dropped, and anything the walk still skipped (an entry
  // that vanished between the two, say). Joined rather than one overwriting the other, because they
  // describe different sets.
  const walkNote =
    skipped > 0
      ? `${skipped} entr(y/ies) were skipped: only regular files are extracted (no symlinks or devices)`
      : null;
  const note =
    [report.note, walkNote, describePathDrops(pathDropped)].filter((n) => n !== null).join('; ') ||
    null;
  if (members.length === 0) return note ?? 'the archive contains no readable files';

  // Handed to the sandbox user in one pass. Best-effort, as it always was here: a worker that is not
  // root cannot chown, and the modes alone keep the tree world-readable.
  const mode = (_current: number, isDir: boolean): number => (isDir ? 0o755 : 0o644);
  await applyTreeNoFollow(anchor, `${stagingRel}/tree`, { owner: SANDBOX_OWNER, mode }).catch(() =>
    applyTreeNoFollow(anchor, `${stagingRel}/tree`, { mode }).catch(() => undefined),
  );
  return {
    members,
    folders,
    longest: Math.max(...members.map((m) => m.rel.length)),
    note,
  };
}

type Placement = { kind: 'placed' } | { kind: 'superseded' } | { kind: 'unplaced' };

/**
 * Move a staged tree into place and write its rows, as ONE section under the task's attachments
 * lock: the archive is re-checked, earlier attempts at it are settled, a free folder is claimed, and
 * the rows and the stamp are written together — so two overlapping calls produce one tree, and a
 * delete never lands between a file being placed and its row existing.
 *
 * The intent is written before each move and the tree is moved whole, so an attempt that dies
 * anywhere in here leaves either its tree still staged or a `placed-as` naming exactly what the next
 * call must take back. A throw after the move takes the files back INSIDE the callback: the driver
 * can reject the transaction while the callback is still running, and nothing outside it may assume
 * the callback has stopped.
 */
async function placeTree(
  db: Database,
  taskId: string,
  anchor: string,
  uploadsRel: string,
  staging: string,
  archive: typeof schema.taskAttachments.$inferSelect,
  staged: StagedTree,
): Promise<Placement> {
  const stagingRel = stagingRelOf(uploadsRel, staging);
  return withTaskAttachmentsLock<Placement>(db, taskId, async (tx) => {
    const current = await tx.query.taskAttachments.findFirst({
      where: eq(schema.taskAttachments.id, archive.id),
      columns: { id: true, expandedAt: true },
    });
    if (current === undefined || current.expandedAt !== null) return { kind: 'superseded' };
    await settleExpansionAttempts(tx, taskId, anchor, uploadsRel, new Set([archive.id]), staging);

    const files = staged.members.map((m) => m.rel);
    let dir: string | null = null;
    for (const candidate of staged.folders) {
      // Candidates only grow longer, so the first one too long ends the search.
      if (candidate.length + 1 + staged.longest > ATTACHMENT_MAX_PATH_LENGTH) break;
      await writeFileNoFollow(
        anchor,
        `${stagingRel}/${EXPANSION_INTENT_FILE}`,
        JSON.stringify({ dir: candidate, files }),
        { fileMode: 0o600 },
      );
      try {
        await renameNoFollow(anchor, `${stagingRel}/tree`, `${uploadsRel}/${candidate}`, {
          noReplace: true,
        });
        dir = candidate;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw err;
      }
    }
    if (dir === null) {
      await stamp(tx, archive.id, NO_FOLDER_NOTE);
      return { kind: 'unplaced' };
    }

    try {
      await tx.insert(schema.taskAttachments).values(
        staged.members.map((m) => ({
          taskId,
          userId: archive.userId,
          filename: `${dir}/${m.rel}`,
          storedPath: path.join(anchor, uploadsRel, dir, m.rel),
          sizeBytes: m.size,
          contentType: null,
          description: null,
          expandedFromId: archive.id,
        })),
      );
      // Under the lock nothing else can stamp or delete it, so a miss here is a defect, and the
      // whole placement is taken back rather than left without the stamp that marks it done.
      if (!(await stamp(tx, archive.id, staged.note === null ? null : storedNote(staged.note)))) {
        throw new Error('the archive changed while its contents were being placed');
      }
    } catch (err) {
      const placed = files.map((file) => `${dir}/${file}`);
      await removeFiles(anchor, uploadsRel, placed);
      await pruneAfter(anchor, uploadsRel, placed);
      throw err;
    }
    return { kind: 'placed' };
  });
}

/** Remove an attempt's staging dir unless it records a placement that may still need taking back:
 *  a `placed-as` whose tree has left. That one is settled by the next call that holds the lock. */
async function discardStaging(anchor: string, stagingRel: string): Promise<void> {
  if (
    (await readExpansionIntent(anchor, stagingRel)) !== null &&
    (await lstatNoFollow(anchor, `${stagingRel}/tree`)) === null
  ) {
    return;
  }
  await removeNoFollow(anchor, stagingRel, { recursive: true, repairPermissions: true }).catch(
    () => {},
  );
}

/**
 * Expand every not-yet-expanded archive attached to `taskId`.
 *
 * All-or-nothing per archive: a cap breach or an unreadable archive records a note and places
 * nothing, and a failure while the tree is being placed takes back every file and row of it, because
 * a partial tree is worse than none — nothing downstream can tell which half of a specification it
 * was given. A placement that fails leaves the archive unstamped, so the next call tries again from
 * the start; so does a lock that could not be had in time.
 */
export async function ensureArchivesExpanded(
  db: Database,
  taskId: string,
): Promise<ExpandArchivesResult> {
  let rows: (typeof schema.taskAttachments.$inferSelect)[];
  try {
    rows = await db.query.taskAttachments.findMany({
      where: eq(schema.taskAttachments.taskId, taskId),
      orderBy: asc(schema.taskAttachments.createdAt),
    });
  } catch (err) {
    log.warn({ err, taskId }, 'could not load attachments for archive expansion');
    return EMPTY;
  }
  // A row that came OUT of an archive is never itself expanded. That is what makes "nested archives
  // are not recursed" structural rather than a depth counter, and it is why an archive inside an
  // archive stays a file.
  const archives = rows.filter(
    (row) =>
      row.expandedAt === null &&
      row.expandedFromId === null &&
      detectAttachmentArchiveFormat(row.filename) !== null,
  );

  // Derived from a row rather than from the task's repository: the row says where its own bytes are,
  // so this needs no repo lookup and cannot write a tree somewhere the originals are not. The ANCHOR
  // is the repository root, recovered by removing the suffix the api wrote — the uploads dir itself
  // sits under `.haive/`, which the sandbox mounts read-write, so it can never be one. A row that does
  // not have that shape is refused rather than expanded from a guessed root.
  const split = rows.map((row) => splitAttachmentStoredPath(row, taskId)).find((s) => s !== null);
  if (!split) {
    if (archives.length > 0) {
      log.warn({ taskId, archive: archives[0]!.filename }, 'unrecognised attachment path layout');
    }
    return EMPTY;
  }
  const { anchor, uploadsRel } = split;

  await sweepStaleAttempts(db, taskId, anchor, uploadsRel, new Set(archives.map((a) => a.id)));
  if (archives.length === 0) return EMPTY;

  const result: ExpandArchivesResult = { expanded: 0, filesAdded: 0, notes: [] };
  for (const archive of archives) {
    const staging = `${EXPANSION_STAGING_PREFIX}${archive.id}-${randomUUID()}`;
    const stagingRel = stagingRelOf(uploadsRel, staging);

    let staged: StagedTree | string;
    try {
      staged = await stageTree(anchor, stagingRel, archive, taskId);
    } catch (err) {
      log.warn({ err, taskId, archive: archive.filename }, 'archive expansion failed');
      staged = `could not be expanded: ${expansionErrorLine(err, anchor)}`;
    }
    if (typeof staged === 'string') {
      // ONE line whatever produced it — extraction's own drop note names members raw too — so the
      // stored note is what AGENTS.md promises it is, and not only what a prompt makes of it.
      const note = storedNote(staged);
      if (await stampNote(db, taskId, anchor, uploadsRel, archive.id, note)) {
        result.expanded += 1;
        result.notes.push({ filename: archive.filename, note });
      }
      await discardStaging(anchor, stagingRel);
      continue;
    }

    let placement: Placement;
    try {
      placement = await placeTree(db, taskId, anchor, uploadsRel, staging, archive, staged);
    } catch (err) {
      log.warn({ err, taskId, archive: archive.filename }, 'could not place archive contents');
      // Nothing is stamped: the archive stays a candidate, and the next call starts it over. A
      // placement that reached the disk is settled first, under the lock, unless the lock itself
      // was the problem.
      if (!isLockNotAvailable(err)) {
        await withTaskAttachmentsLock(db, taskId, (tx) =>
          settleExpansionAttempts(tx, taskId, anchor, uploadsRel, new Set([archive.id])),
        ).catch(() => {});
      }
      await discardStaging(anchor, stagingRel);
      continue;
    }
    // Committed, so what `placed-as` names is owned by rows now, and the staging dir can go whole.
    await removeNoFollow(anchor, stagingRel, { recursive: true, repairPermissions: true }).catch(
      () => {},
    );
    if (placement.kind === 'superseded') continue;
    result.expanded += 1;
    if (placement.kind === 'unplaced') {
      result.notes.push({ filename: archive.filename, note: NO_FOLDER_NOTE });
      continue;
    }
    result.filesAdded += staged.members.length;
    if (staged.note !== null) {
      result.notes.push({ filename: archive.filename, note: storedNote(staged.note) });
    }
  }

  // The api writes this index on upload and delete; the expansion is the third writer, and a prompt
  // that tells every agent to read it must not point at an index missing the files just added.
  if (result.filesAdded > 0) await rewriteAttachmentsManifest(db, taskId, anchor, uploadsRel);
  log.info(
    { taskId, expanded: result.expanded, filesAdded: result.filesAdded },
    'expanded task archives',
  );
  return result;
}
