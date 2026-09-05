import type { ArchiveFormat } from '../types/index.js';

/** Archives an attachment upload can be expanded from, by extension. The same
 *  four the repo-archive upload accepts, and for the same reason: they are what
 *  `unzip` and `tar` in the worker image can open. */
export function detectAttachmentArchiveFormat(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  return null;
}

/** The directory an archive expands into: its name without the archive
 *  extension. `spec.tar.gz` gives `spec`, not `spec.tar`. */
export function archiveStem(filename: string): string {
  return filename.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '');
}

/** Files one archive may expand to. Past this the archive is left unexpanded and
 *  reported: a partial tree is worse than none, because nothing downstream can
 *  tell which half it got. */
export const ATTACHMENT_ARCHIVE_MAX_FILES = 500;

/** Total uncompressed bytes one archive may expand to. Guards the volume against
 *  a compression bomb, which no upload-time byte cap can see. */
export const ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
