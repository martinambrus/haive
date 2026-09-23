import { asc, eq } from 'drizzle-orm';
import { schema, withTaskAttachmentsLock, type Database, type DbTx } from '@haive/database';
import { ATTACHMENTS_MANIFEST_NAME, renderAttachmentsManifest } from './attachments/manifest.js';
import { splitAttachmentPath } from './attachments/paths.js';
import { chownNoFollow, removeNoFollow, writeFileNoFollow } from './fs-safe.js';
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
