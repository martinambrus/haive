import { asc, eq } from 'drizzle-orm';
import { schema, withTaskAttachmentsLock, type Database, type DbTx } from '@haive/database';
import { ATTACHMENTS_MANIFEST_NAME, renderAttachmentsManifest } from './attachments/manifest.js';
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
