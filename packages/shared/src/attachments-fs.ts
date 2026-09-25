import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, withTaskAttachmentsLock, type Database, type DbTx } from '@haive/database';
import { ATTACHMENT_ARCHIVE_MAX_FILES } from './attachments/archive.js';
import { ATTACHMENTS_MANIFEST_NAME, renderAttachmentsManifest } from './attachments/manifest.js';
import { isReservedAttachmentName } from './attachments/names.js';
import { sanitizeAttachmentPath, splitAttachmentPath } from './attachments/paths.js';
import {
  chownNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  readTextNoFollow,
  removeNoFollow,
  writeFileNoFollow,
} from './fs-safe.js';
import { logger } from './logger/index.js';

/**
 * The attachments manifest's one WRITER, for the api and the worker alike.
 *
 * Node-only, so it lives outside `@haive/shared/attachments` — which the web bundle imports — and
 * outside the root barrel, the same way `fs-safe` does: that module refuses to load anywhere but
 * Linux.
 */

const log = logger.child({ module: 'attachments-manifest' });
/** The sandbox user, which every agent reads the uploads dir as. */
const SANDBOX_UID = 1000;
const SANDBOX_GID = 1000;

/**
 * Rewrite `<uploads>/_ATTACHMENTS.md` from the task's rows, or remove it once none remain.
 *
 * It NEVER throws, because every caller has already done the work the manifest describes — an
 * upload's row exists, a delete's files are gone — and an error here used to turn that into a 500
 * the client retries, which for an upload is a second copy of the file. A link planted at the name
 * is replaced as a link (`replaceLeafLink`), so one planted link no longer blocks every later
 * upload and delete; anything else standing there is logged and left for the next write.
 *
 * The rows are read and the file written under the task's attachments lock, so the last writer to
 * hold it describes the latest rows: two writers reading, then writing in the other order, used to
 * leave a manifest naming a file already deleted. Handed a transaction that holds the lock, it runs
 * as a savepoint of it, which is also what keeps a failed read here from aborting the caller's
 * transaction.
 */
export async function rewriteAttachmentsManifest(
  handle: Database | DbTx,
  taskId: string,
  anchor: string,
  uploadsRel: string,
): Promise<void> {
  const manifestRel = `${uploadsRel}/${ATTACHMENTS_MANIFEST_NAME}`;
  try {
    await withTaskAttachmentsLock(handle, taskId, async (tx) => {
      const rows = await tx.query.taskAttachments.findMany({
        where: eq(schema.taskAttachments.taskId, taskId),
        orderBy: asc(schema.taskAttachments.createdAt),
        columns: { filename: true, description: true },
      });
      const body = renderAttachmentsManifest(rows);
      if (body === null) {
        await removeNoFollow(anchor, manifestRel).catch(() => {});
        return;
      }
      // Replace-atomic: every agent is told to read this index, so a reader sees the old one or
      // the new one and never a partial write.
      await writeFileNoFollow(anchor, manifestRel, body, {
        fileMode: 0o644,
        replaceLeafLink: true,
      });
      // Best-effort: a writer that is not root cannot hand the file over, and 0644 is
      // world-readable.
      await chownNoFollow(anchor, manifestRel, { uid: SANDBOX_UID, gid: SANDBOX_GID }).catch(
        () => {},
      );
    });
  } catch (err) {
    log.warn({ err, taskId }, 'could not rewrite the attachments manifest');
  }
}

/** Remove each listed file (relative to the uploads dir), walked under the repository root like
 *  every other removal of an attachment, so a link in a path is refused rather than followed. A file
 *  already gone is fine: every caller lists what SHOULD be gone. */
export async function removeFiles(
  anchor: string,
  uploadsRel: string,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    await removeNoFollow(anchor, `${uploadsRel}/${file}`).catch(() => {});
  }
}

/** Remove the directories a removed file left empty, stopping at the uploads root or at the first
 *  directory something else still lives in. */
export async function pruneEmptyDirs(
  anchor: string,
  uploadsRel: string,
  relDir: string,
): Promise<void> {
  let cursor = relDir;
  while (cursor !== '' && cursor !== '.') {
    try {
      // Non-recursive on purpose: ENOTEMPTY is the signal to stop, so a directory something else
      // still lives in is left exactly as it is.
      await removeNoFollow(anchor, `${uploadsRel}/${cursor}`);
    } catch {
      return; // not empty, or already gone
    }
    cursor = splitAttachmentPath(cursor).dir;
  }
}

/** Prune every folder the removed files may have emptied, deepest first so a parent is tried after
 *  the children that kept it alive. */
export async function pruneAfter(
  anchor: string,
  uploadsRel: string,
  removed: readonly string[],
): Promise<void> {
  const dirs = [...new Set(removed.map((f) => splitAttachmentPath(f).dir))].filter((d) => d !== '');
  dirs.sort((a, b) => b.split('/').length - a.split('/').length);
  for (const dir of dirs) await pruneEmptyDirs(anchor, uploadsRel, dir);
}

/**
 * One attempt at expanding one archive works in its own `.expanding-<archiveId>-<nonce>` directory
 * under the uploads dir. The leading dot keeps it out of every attachment's way (the path sanitiser
 * strips leading dots per segment). Before its tree is moved into place the attempt writes
 * `placed-as` there — the folder and the files it is about to own — and the directory goes only once
 * the rows naming them are committed, so an attempt that died in between can be taken back. The
 * worker's expansion writes these; the settling lives here because a DELETE settles the attempts at
 * the archives it removes too.
 */
export const EXPANSION_STAGING_PREFIX = '.expanding-';
export const EXPANSION_INTENT_FILE = 'placed-as';
const EXPANSION_INTENT_MAX_BYTES = 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Also matches the nonce-less `.expanding-<archiveId>` an interrupted run before the nonce left. */
const EXPANSION_STAGING_NAME = new RegExp(`^\\.expanding-(${UUID})(?:-${UUID})?$`, 'i');

/** What `placed-as` records: the folder a staged tree was about to become, and its files. */
export interface ExpansionIntent {
  dir: string;
  files: string[];
}

/** The archive an expansion attempt's staging dir belongs to, or null for any other name. */
export function expansionAttemptArchiveId(name: string): string | null {
  return EXPANSION_STAGING_NAME.exec(name)?.[1] ?? null;
}

/**
 * Read an attempt's `placed-as`, or null when there is none — or none to trust. The uploads dir is
 * inside a tree the sandbox can write, so an intent is held to what an expansion could have written:
 * one folder, no more names than an archive may hold, and names that pass the attachment path rules
 * and that no generated file owns. A sidecar has no row of its own, so an intent naming one would
 * otherwise remove a live document's extracted text as an orphan. The count matters as much: every
 * name becomes a bind parameter of the settle's one query, and a list past Postgres' limit fails the
 * section — in a delete, after the files have gone.
 */
export async function readExpansionIntent(
  anchor: string,
  stagingRel: string,
): Promise<ExpansionIntent | null> {
  const text = await readTextNoFollow(anchor, `${stagingRel}/${EXPANSION_INTENT_FILE}`, {
    maxBytes: EXPANSION_INTENT_MAX_BYTES,
  }).catch(() => null);
  if (text === null) return null;
  try {
    const { dir, files } = JSON.parse(text) as { dir?: unknown; files?: unknown };
    if (typeof dir !== 'string' || dir.includes('/') || sanitizeAttachmentPath(dir) !== dir) {
      return null;
    }
    if (!Array.isArray(files) || files.length > ATTACHMENT_ARCHIVE_MAX_FILES) return null;
    for (const file of files) {
      if (
        typeof file !== 'string' ||
        sanitizeAttachmentPath(file) !== file ||
        isReservedAttachmentName(splitAttachmentPath(file).base, false)
      ) {
        return null;
      }
    }
    return { dir, files: files as string[] };
  } catch {
    return null;
  }
}

/**
 * Settle one expansion attempt, inside a section holding the task's attachments lock. Its intent
 * says what it may have placed; a file no row owns was placed by an attempt whose rows never
 * committed, and it is removed. Its staged tree still being there means the move never happened, and
 * then at most the empty folder it claimed is left — which is removed only while it is an empty
 * DIRECTORY.
 *
 * The intent goes here, inside the section, so no later settle can act on what this one resolved: a
 * name freed by it is one an upload can take, and that upload's file has no row until its bytes are
 * in. The staging dir does NOT go here — it can hold a whole extracted archive, bomb-sized included,
 * and removing it must not hold the lock and a pooled connection. `removeExpansionStagings` takes it
 * once the section is over. Answers whether there was an intent to settle.
 */
export async function settleExpansionAttempt(
  tx: DbTx,
  taskId: string,
  anchor: string,
  uploadsRel: string,
  staging: string,
): Promise<boolean> {
  const stagingRel = `${uploadsRel}/${staging}`;
  const intent = await readExpansionIntent(anchor, stagingRel);
  if (intent !== null) {
    const claimed = `${uploadsRel}/${intent.dir}`;
    if ((await lstatNoFollow(anchor, `${stagingRel}/tree`)) !== null) {
      if ((await lstatNoFollow(anchor, claimed))?.kind === 'directory') {
        await removeNoFollow(anchor, claimed).catch(() => {});
      }
    } else {
      const names = intent.files.map((file) => `${intent.dir}/${file}`);
      const owned = new Set<string>();
      if (names.length > 0) {
        const rows = await tx.query.taskAttachments.findMany({
          where: and(
            eq(schema.taskAttachments.taskId, taskId),
            inArray(schema.taskAttachments.filename, names),
          ),
          columns: { filename: true },
        });
        for (const row of rows) owned.add(row.filename);
      }
      const orphans = names.filter((name) => !owned.has(name));
      await removeFiles(anchor, uploadsRel, orphans);
      await pruneAfter(anchor, uploadsRel, orphans);
    }
    await removeNoFollow(anchor, `${stagingRel}/${EXPANSION_INTENT_FILE}`).catch(() => {});
  }
  return intent !== null;
}

/** Settle every attempt that wrote its intent, inside an upload's claim section: a dead attempt's intent
 *  can name a path free on disk, and settling it after the claim took that name would remove the upload.
 *  Adds each staging dir to `settled` as soon as it is settled, so one settled before a later attempt
 *  throws is still removed; one still extracting has no intent and is left alone. */
export async function settleExpansionIntents(
  tx: DbTx,
  taskId: string,
  anchor: string,
  uploadsRel: string,
  settled: string[],
): Promise<void> {
  for (const entry of (await readdirNoFollow(anchor, uploadsRel)) ?? []) {
    if (
      expansionAttemptArchiveId(entry.name) !== null &&
      (await settleExpansionAttempt(tx, taskId, anchor, uploadsRel, entry.name))
    ) {
      settled.push(entry.name);
    }
  }
}

/** Settle every expansion attempt at the given archives but `keep`, inside a section holding the
 *  task's attachments lock. Answers the staging dirs it settled, for `removeExpansionStagings` once
 *  the section is over. */
export async function settleExpansionAttempts(
  tx: DbTx,
  taskId: string,
  anchor: string,
  uploadsRel: string,
  archiveIds: ReadonlySet<string>,
  keep: string | null = null,
): Promise<string[]> {
  const settled: string[] = [];
  const entries = (await readdirNoFollow(anchor, uploadsRel)) ?? [];
  for (const entry of entries) {
    const archiveId = expansionAttemptArchiveId(entry.name);
    if (entry.name !== keep && archiveId !== null && archiveIds.has(archiveId)) {
      await settleExpansionAttempt(tx, taskId, anchor, uploadsRel, entry.name);
      settled.push(entry.name);
    }
  }
  return settled;
}

/** Remove settled attempts' staging dirs — OUTSIDE any section, since one can hold a whole extracted
 *  archive. Best-effort: once settled a dir is inert, and the worker's sweep retries one left behind. */
export async function removeExpansionStagings(
  anchor: string,
  uploadsRel: string,
  stagings: readonly string[],
): Promise<void> {
  for (const staging of stagings) {
    await removeNoFollow(anchor, `${uploadsRel}/${staging}`, {
      recursive: true,
      repairPermissions: true,
    }).catch(() => {});
  }
}
