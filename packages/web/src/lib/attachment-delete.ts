import { archivesEmptiedBy } from '@haive/shared/attachments';
import type { TaskAttachment } from './api-client';

/** The confirmation for removing one attachment. It names the archive the file came out of when this
 *  is the last of that archive's files, because the api then removes the archive as well — by the
 *  same shared rule, so what is named is exactly what goes. */
export function deleteAttachmentConfirmation(items: readonly TaskAttachment[], id: string): string {
  const base = 'Remove this attachment? The agent will no longer see it.';
  const [archive] = archivesEmptiedBy(items, new Set([id]));
  return archive === undefined
    ? base
    : `${base} ${archive.filename}, which it was extracted from, is removed with it.`;
}

/** The confirmation for removing a top-level folder: every file under it, plus any archive whose
 *  extracted files all live there. */
export function deleteFolderConfirmation(items: readonly TaskAttachment[], name: string): string {
  const inside = items.filter((i) => i.filename.startsWith(`${name}/`));
  const base = `Remove the folder "${name}" and all ${inside.length} file(s) in it?`;
  const archives = archivesEmptiedBy(items, new Set(inside.map((i) => i.id)));
  return archives.length === 0
    ? base
    : `${base} This also removes ${archives.map((a) => a.filename).join(', ')}.`;
}
