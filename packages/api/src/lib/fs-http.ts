import { isPathContainmentError } from '@haive/shared/fs-safe';
import { HttpError } from '../context.js';

/**
 * One rendering of a containment refusal for every route that reads a repository path.
 *
 * The routes call the `@haive/shared/fs-safe` primitives in `strict` mode, where a refusal throws
 * rather than folding into `null`: a browser asking for a path that is a link, or that leaves the
 * tree, deserves a status and a reason, not an empty body that reads like an empty file. Absence
 * stays `null` at the call site and becomes the caller's own 404, since only the route knows
 * whether a missing file is "not found" or "no longer exists".
 *
 * `invalid-path` and `out-of-tree` share the 403 because they are the same answer from the
 * client's side — the path was not inside the workspace — while the distinction (a caller bug
 * versus a tree that moved under us) matters only in the log.
 */
export function containmentHttpError(
  err: unknown,
  outside = 'Path is outside the workspace',
): never {
  if (isPathContainmentError(err, 'link')) throw new HttpError(403, 'Path is a symlink');
  if (isPathContainmentError(err, 'not-regular-file')) {
    throw new HttpError(400, 'Path is not a regular file');
  }
  if (isPathContainmentError(err, 'not-directory')) throw new HttpError(404, 'File not found');
  if (isPathContainmentError(err, 'unverifiable')) {
    throw new HttpError(403, 'Cannot verify the file path');
  }
  if (isPathContainmentError(err)) throw new HttpError(403, outside);
  if (err instanceof HttpError) throw err;
  throw new HttpError(400, 'Path cannot be read');
}
