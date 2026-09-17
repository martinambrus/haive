import type { FileHandle } from 'node:fs/promises';
import { ensureDirNoFollow, openFileNoFollow } from '@haive/shared/fs-safe';
import { HttpError } from '../context.js';

/**
 * The upload staging directory, and the one place the api resolves the storage volume.
 *
 * THERE WERE FOUR COPIES of the root resolver — `routes/repos.ts`, `routes/db-dumps.ts`,
 * `routes/user-settings.ts` and `routes/tasks/_helpers.ts` each carried an identical one — and
 * three separate copies of the `_uploads/<userId>` split grew beside them. That is the drift a
 * shared home exists to stop: an install that moves the volume by env var has to move every reader
 * at once, and a containment rule written three times is a containment rule that will diverge.
 */
export function uploadsStorageRoot(): string {
  return process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
}

/**
 * The per-user staging dir as a rel under the storage root.
 *
 * That directory CANNOT be an anchor. It lives in the `haive_repos` volume, which the worker's
 * `sandbox/ddev-runner.ts` and `sandbox/app-runner.ts` both mount WHOLE at `/repos`, so a per-task
 * runtime container can write into it. The storage root is the trusted end of the path and every
 * component below it is walked rather than resolved by name.
 */
export function uploadsRel(userId: string): string {
  return `_uploads/${userId}`;
}

/**
 * Create `<root>/_uploads/<userId>`, walking each component. Returns the anchor to use with it.
 *
 * `root` is a parameter because the bundle routes stage into the SAME `_uploads/<userId>` shape
 * under a different volume (`BUNDLE_STORAGE_ROOT`). Defaulted, so the repo-storage callers read
 * exactly as they did before — and parameterised only once a second caller existed to shape it
 * against, rather than guessed at when this module was written.
 */
export async function ensureUploadsDir(
  userId: string,
  root = uploadsStorageRoot(),
): Promise<string> {
  await ensureDirNoFollow(root, uploadsRel(userId), { mode: 0o755 });
  return root;
}

/**
 * The rel of a file this api wrote under the uploads dir, recovered from a stored column.
 *
 * A row carries an ABSOLUTE path, which is a path this code did not build, so the SHAPE is the
 * validation — the same rule `splitAttachmentStoredPath` applies to an attachment, and the one the
 * worker's `splitUploadPath` applies to this very directory from the other side. Anything that is
 * not exactly `<root>/_uploads/<userId>/<name>` answers null and the caller refuses, because the
 * alternative is picking a directory and hoping.
 *
 * A `..` name is refused HERE rather than left to the primitive: `toSafeRel` would throw
 * `invalid-path` on it, which the refusal rule defines as a caller bug, and several callers wrap
 * their primitive in a `.catch` — so the throw would be swallowed and read as "nothing to do".
 */
export function uploadFileRel(
  userId: string,
  stored: string,
  root = uploadsStorageRoot(),
): string | null {
  const prefix = `${root}/${uploadsRel(userId)}/`;
  if (!stored.startsWith(prefix)) return null;
  const name = stored.slice(prefix.length);
  if (name === '' || name.includes('/') || name === '.' || name === '..') return null;
  return `${uploadsRel(userId)}/${name}`;
}

/**
 * `uploadFileRel`, for a caller that cannot carry on without the rel.
 *
 * A 409 rather than a 404: the row exists and names a path this api did not write, which is a
 * conflict between the row and the layout rather than a missing file. `what` names the column in
 * the message, since a user reading it has no idea which of several upload kinds refused.
 */
export function uploadFileRelOrThrow(
  userId: string,
  stored: string,
  what: string,
  root = uploadsStorageRoot(),
): string {
  const rel = uploadFileRel(userId, stored, root);
  if (rel === null) throw new HttpError(409, `${what} is not in this user uploads directory`);
  return rel;
}

/**
 * Roll a partial upload back to the byte count its session row still claims.
 *
 * A second verified open rather than the write stream's own handle: MEASURED on node v26.7.0, a
 * FileHandle write stream CLOSES the handle at `finish`, so after a failed chunk the name has to be
 * resolved again anyway — and resolving it again re-checks it. Absent is a no-op, since there is
 * then nothing to roll back.
 */
export async function truncateUploadFile(anchor: string, rel: string, size: number): Promise<void> {
  const fh: FileHandle | null = await openFileNoFollow(anchor, rel, 'read-write');
  if (!fh) return;
  try {
    await fh.truncate(size);
  } finally {
    await fh.close();
  }
}
