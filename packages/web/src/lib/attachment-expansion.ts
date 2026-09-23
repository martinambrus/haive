import { detectAttachmentArchiveFormat } from '@haive/shared/attachments';
import type { TaskAttachment } from './api-client';

/** An archive the worker has not expanded yet, which is what the attachments panel keeps
 *  re-reading for. Mirrors the worker's own candidate rule (`ensureArchivesExpanded`): an archive
 *  by name, never stamped, and not itself a member of another archive. A nested archive is never
 *  expanded, so waiting on one would never end. Strictly `null`: an api that predates these fields
 *  sends neither, and that is not "waiting". */
export function awaitingExpansion(a: TaskAttachment): boolean {
  return (
    a.expandedAt === null &&
    a.expandedFromId === null &&
    detectAttachmentArchiveFormat(a.filename) !== null
  );
}
