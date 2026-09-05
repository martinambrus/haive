/**
 * Attachment names are RELATIVE PATHS, not basenames.
 *
 * A user attaching a requirements folder keeps its structure: `task_attachments.
 * filename` holds `docs/api/spec.md` and the file lands at that path under the
 * task's uploads dir, which the sandbox already bind-mounts whole. The api
 * sanitises what the browser sends; the worker sanitises what it reads out of an
 * uploaded archive. One module, because the two must agree — a name the api
 * refuses and the worker accepts is a file only one of them can find.
 *
 * The allowlist is the one the basename sanitiser used before paths existed:
 * everything outside `[\w .()-]` becomes `_`, and leading dots are stripped
 * per SEGMENT (so `.ssh/id_rsa` is `ssh/id_rsa`, and no dotfile or dot-directory
 * survives anywhere in the path).
 */

export const ATTACHMENT_MAX_SEGMENT_LENGTH = 200;
/** Directory levels above the file itself. A real spec folder is 2-4 deep. */
export const ATTACHMENT_MAX_PATH_DEPTH = 16;
export const ATTACHMENT_MAX_PATH_LENGTH = 400;

/** A path that cannot be repaired, only refused. The api turns this into a 400. */
export class AttachmentPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentPathError';
  }
}

/** One path segment, reduced to the safe allowlist. May return `''` when the
 *  segment was nothing but dots or control characters. */
export function sanitizeAttachmentSegment(raw: string): string {
  return raw
    .replace(/[^\w .()\-]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, ATTACHMENT_MAX_SEGMENT_LENGTH);
}

/**
 * A relative path safe to join onto the uploads dir: no absolute prefix, no
 * traversal, bounded depth and length.
 *
 * `..` THROWS rather than being dropped. Every legitimate producer — the
 * browser's `webkitRelativePath`, an archive member name — can express a path
 * without one, so its presence is not a name to repair quietly: dropping the
 * segment silently relocates the file somewhere the user did not ask for, and
 * the caller should know the upload was refused.
 */
export function sanitizeAttachmentPath(raw: string): string {
  const parts = raw.split(/[\\/]/);
  if (parts.some((part) => part.trim() === '..')) {
    throw new AttachmentPathError(`attachment path "${raw}" contains a parent-directory segment`);
  }

  const segments: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '' || trimmed === '.') continue;
    const safe = sanitizeAttachmentSegment(part);
    // Nothing but dots or control characters: drop it rather than inventing a
    // directory name. The file moves one level up, which is inside either way.
    if (safe !== '') segments.push(safe);
  }

  // Every segment vanished (`''`, `///`, `...`). The old basename sanitiser
  // answered `file` here and callers rely on always getting a usable name.
  if (segments.length === 0) return 'file';

  if (segments.length - 1 > ATTACHMENT_MAX_PATH_DEPTH) {
    throw new AttachmentPathError(
      `attachment path "${raw}" is nested deeper than ${ATTACHMENT_MAX_PATH_DEPTH} directories`,
    );
  }
  const joined = segments.join('/');
  if (joined.length > ATTACHMENT_MAX_PATH_LENGTH) {
    throw new AttachmentPathError(
      `attachment path "${raw}" is longer than ${ATTACHMENT_MAX_PATH_LENGTH} characters`,
    );
  }
  return joined;
}

/** `docs/api/spec.md` to `{ dir: 'docs/api', base: 'spec.md' }`; a root file has
 *  `dir: ''`. Separator is always `/` — that is what `sanitizeAttachmentPath`
 *  emits and what the column therefore holds. */
export function splitAttachmentPath(filename: string): { dir: string; base: string } {
  const cut = filename.lastIndexOf('/');
  return cut === -1
    ? { dir: '', base: filename }
    : { dir: filename.slice(0, cut), base: filename.slice(cut + 1) };
}

/** The uploads root a row was written under. `storedPath` is `<root>/<filename>`
 *  by construction — the api writes the two together — so the row itself says
 *  where its tree lives and no caller has to reconstruct it from a repository.
 *  For a legacy flat name this is the same directory it always was.
 *
 *  POSIX separators, deliberately: these paths are built inside the Linux
 *  containers that own the volume, and this module is bundled for the browser
 *  too, so it must not reach for `node:path`. */
export function attachmentUploadsRoot(row: { storedPath: string; filename: string }): string {
  const suffix = `/${row.filename}`;
  if (row.storedPath.endsWith(suffix)) return row.storedPath.slice(0, -suffix.length);
  const cut = row.storedPath.lastIndexOf('/');
  return cut === -1 ? row.storedPath : row.storedPath.slice(0, cut);
}
