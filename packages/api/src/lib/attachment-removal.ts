import { archivesEmptiedBy, planInputSidecarName } from '@haive/shared';

export interface RemovableAttachment {
  id: string;
  filename: string;
  expandedFromId: string | null;
}

/**
 * Every file a delete takes off the disk, relative to the uploads dir: the deleted attachments' own
 * files, the members of any deleted archive, and each one's extracted-text sidecar.
 *
 * Two kinds of file outlive their original unless listed here, and both stay bind-mounted into the
 * sandbox, so an agent keeps reading them after the person believes the content is gone:
 *
 *  - the worker's extracted-text SIDECAR beside a document. Every removed file's sidecar name is
 *    listed, whatever its kind — removing an absent one is a no-op, and a kind that gains a sidecar
 *    later is covered without a change here. A name a SURVIVING row owns is left alone: sidecar
 *    names are not reserved, so it can be a real attachment someone uploaded.
 *  - an archive's MEMBERS. Their rows cascade on the delete; their files do not. An archive anywhere
 *    expands into one directory at the uploads ROOT, so a folder delete that takes `docs/x.zip` must
 *    also take `x/…`, which is not under `docs/`.
 *
 * A file a SURVIVING row still names is never removed, nor its sidecar: nothing stops two rows naming
 * one file (the upload claim reads the disk, not the rows, so a row whose file had gone lets a new
 * upload take its name), and removing a shared file for one of them takes the other's too.
 *
 * Files, never a directory: a folder goes only by pruning, once nothing is left in it. Removing one
 * recursively takes whatever else lives there — a later folder upload named like an expansion
 * directory lands INSIDE it (the api de-dupes files, not directories), and an upload racing the
 * delete has its file on disk before its row exists, where no list of rows can see it. Either way
 * those rows would outlive their files.
 */
export function filesToRemove(
  doomed: ReadonlySet<string>,
  rows: readonly RemovableAttachment[],
): string[] {
  const removed = rows.filter(
    (r) => doomed.has(r.id) || (r.expandedFromId !== null && doomed.has(r.expandedFromId)),
  );
  const removedIds = new Set(removed.map((r) => r.id));
  const survivingNames = new Set(rows.filter((r) => !removedIds.has(r.id)).map((r) => r.filename));
  const files = removed.flatMap((r) => {
    if (survivingNames.has(r.filename)) return [];
    const sidecar = planInputSidecarName(r.filename);
    return survivingNames.has(sidecar) ? [r.filename] : [r.filename, sidecar];
  });
  return [...new Set(files)];
}

export interface RemovalPlan {
  /** The rows to delete: the doomed ones, plus any archive they leave with no extracted file. */
  ids: string[];
  /** The files to remove, as `filesToRemove` lists them for those rows. */
  files: string[];
}

/** Everything a delete of `doomed` removes. An archive whose every extracted file is doomed goes
 *  with them (`archivesEmptiedBy`, the rule the attachments panel's confirmation names too), or it
 *  would stay listed as expanded with nothing of it left, and never be expanded again. */
export function attachmentRemovalPlan(
  doomed: ReadonlySet<string>,
  rows: readonly RemovableAttachment[],
): RemovalPlan {
  const ids = new Set(doomed);
  for (const archive of archivesEmptiedBy(rows, doomed)) ids.add(archive.id);
  return { ids: [...ids], files: filesToRemove(ids, rows) };
}
