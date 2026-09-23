import type { ArchiveFormat } from '../types/index.js';

/** Every extension an attachment archive is recognised by, with its format: the same four the
 *  repo-archive upload accepts, and for the same reason — they are what `unzip` and `tar` in the
 *  worker image can open. One list, because two readers must agree on it: detection, and the
 *  name de-dupe that has to keep a two-part extension whole (`splitAttachmentExtension`). Longest
 *  first, so `.tar.gz` is matched before anything shorter could claim the name. */
export const ATTACHMENT_ARCHIVE_EXTENSIONS: readonly (readonly [string, ArchiveFormat])[] = [
  ['.tar.gz', 'tar.gz'],
  ['.tgz', 'tar.gz'],
  ['.zip', 'zip'],
  ['.tar', 'tar'],
];

function archiveExtension(filename: string): readonly [string, ArchiveFormat] | undefined {
  const lower = filename.toLowerCase();
  return ATTACHMENT_ARCHIVE_EXTENSIONS.find(([ext]) => lower.endsWith(ext));
}

/** Archives an attachment upload can be expanded from, by extension. */
export function detectAttachmentArchiveFormat(filename: string): ArchiveFormat | null {
  return archiveExtension(filename)?.[1] ?? null;
}

/** The directory an archive expands into: its name without the archive
 *  extension. `spec.tar.gz` gives `spec`, not `spec.tar`. */
export function archiveStem(filename: string): string {
  const hit = archiveExtension(filename);
  return hit ? filename.slice(0, -hit[0].length) : filename;
}

/** Files one archive may expand to. Past this the archive is left unexpanded and
 *  reported: a partial tree is worse than none, because nothing downstream can
 *  tell which half it got. */
export const ATTACHMENT_ARCHIVE_MAX_FILES = 500;

/** Total uncompressed bytes one archive may expand to. Guards the volume against
 *  a compression bomb, which no upload-time byte cap can see. */
export const ATTACHMENT_ARCHIVE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
