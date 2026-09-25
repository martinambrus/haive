import path from 'node:path';

/** Where 01-worktree-setup puts a task's feature worktree, relative to the repo root.
 *  Already git-excluded via .git/info/exclude. */
export const WORKTREE_SUBDIR = '.haive/worktrees';

/** The worktree DIRECTORY name for a branch. A namespaced branch (`feature/x`)
 *  flattens its slashes so the on-disk layout stays one level under the subdir; the
 *  branch ref keeps its slash. */
export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, '-');
}

/** Host + sandbox paths for a worktree directory name. Callers that suffix the name
 *  (`--base` for the transient merge worktree, `--<issue>` for a DAG issue worktree)
 *  build the name themselves and pass it here, so the layout lives in one place. */
export function worktreeDirPaths(
  repoRoot: string,
  sandboxWorkdir: string,
  dirName: string,
): { worktreePath: string; sandboxWorktreePath: string } {
  return {
    worktreePath: `${repoRoot}/${WORKTREE_SUBDIR}/${dirName}`,
    sandboxWorktreePath: `${sandboxWorkdir}/${WORKTREE_SUBDIR}/${dirName}`,
  };
}

/** The feature worktree's path as seen INSIDE a sandbox, where the repo root is
 *  mounted at `sandboxWorkdir`. Derived from the branch so the naming rule lives in
 *  one place — 01-worktree-setup writes the path, resolveTaskSandboxWorkdir rebuilds
 *  it when the step output has been reset. */
export function sandboxWorktreePath(sandboxWorkdir: string, branch: string): string {
  return worktreeDirPaths('', sandboxWorkdir, worktreeDirName(branch)).sandboxWorktreePath;
}

/** Split a repo-volume subpath (`<userId>/<repoId>` or that plus a worktree rel) into the anchor
 *  the containment primitives take and the rel below it.
 *
 *  The first two segments are the repository root, and that is the boundary that matters: the root
 *  and its parents are created by the worker and owned by root, while everything BELOW it is
 *  written by the repository's own content and by sandboxed agents (the whole root is mounted
 *  read-write into cli-exec). So the root may be reached by name and the rest must be walked. */
export function splitRepoSubpath(
  storageRoot: string,
  subpath: string,
): { anchor: string; rel: string } {
  const [userId, repoId, ...rest] = subpath.split('/').filter((seg) => seg !== '');
  if (userId === undefined || repoId === undefined) {
    throw new Error(`repo subpath ${subpath} does not name <userId>/<repoId>`);
  }
  return { anchor: `${storageRoot}/${userId}/${repoId}`, rel: rest.join('/') };
}

/**
 * Split an absolute path to an uploaded archive or DB dump into the storage root and the rel below
 * it, refusing anything that is not `<storageRoot>/_uploads/<owner>/<name>`.
 *
 * `_uploads/<userId>` cannot itself be an anchor: it lives in the `haive_repos` volume, which
 * `ddev-runner` and `app-runner` both mount WHOLE at `/repos`, so a project's own runtime can write
 * into it. The storage root is the trusted end, and both segments below it are walked.
 *
 * Null rather than a guess when the shape does not match — a legacy row, or a path written by
 * something else — as `splitWorktreePath` and `splitAttachmentStoredPath` both do. The api applies
 * the same rule with the userId in hand (`uploadFileRel`, `api/src/lib/uploads.ts`); a row reaching
 * the worker carries no userId, so the SHAPE is the whole check.
 */
export function splitUploadPath(
  storageRoot: string,
  stored: string,
): { anchor: string; rel: string } | null {
  const name = path.basename(stored);
  const owner = path.basename(path.dirname(stored));
  // A traversal segment is refused HERE rather than left to the primitive. `toSafeRel` would throw
  // `invalid-path` on it, which the refusal rule defines as a caller bug — and both callers wrap
  // their primitive in a `.catch`, so the throw would be swallowed and read as "nothing to do".
  // A guard that answers null is the honest shape, as `safeDiskRel` concluded in #137.
  if (!owner || !name || owner === '.' || owner === '..' || name === '.' || name === '..') {
    return null;
  }
  // The api writes the path as `path.join(root, '_uploads', owner, name)`, so rebuilding it the
  // same way compares like with like whatever form the root was configured in: relative, with a
  // trailing slash, or `/`. Anything else names a different file or a segment the api never writes.
  if (path.join(storageRoot, '_uploads', owner, name) !== stored) return null;
  return { anchor: storageRoot, rel: `_uploads/${owner}/${name}` };
}

/** Split a repository's `storage_path` into its user directory and the repository's name there,
 *  or null for anything but `<storageRoot>/<userId>/<repoId>`. Rebuilt as `splitUploadPath`
 *  rebuilds, since the repo handlers write it with `path.join` whatever form the root takes. */
export function splitRepoStoragePath(
  storageRoot: string,
  stored: string,
): { anchor: string; rel: string } | null {
  const repo = path.basename(stored);
  const owner = path.basename(path.dirname(stored));
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    return null;
  }
  if (path.join(storageRoot, owner, repo) !== stored) return null;
  return { anchor: path.join(storageRoot, owner), rel: repo };
}

/**
 * Split a worktree path into the repository root and the rel below it, refusing anything that is not
 * `<repoRoot>/.haive/worktrees/<dir>`.
 *
 * The shape IS the validation, and it is the reason this exists. Such a path arrives from a `tasks`
 * column or a legacy step output, and a RECURSIVE DELETE must never be aimed at the repository root
 * — or anywhere else — merely because a row said so. Deriving the root from the path is also what
 * keeps the orphaned-worktree case working: when the repositories row is gone there is no
 * `storagePath` to anchor against, but the path still names the root it lives under.
 */
export function splitWorktreePath(worktreePath: string): { anchor: string; rel: string } | null {
  const normalized = path.posix.normalize(worktreePath).replace(/\/+$/, '');
  const marker = `/${WORKTREE_SUBDIR}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx <= 0) return null;
  const dirName = normalized.slice(idx + marker.length);
  if (dirName === '' || dirName.includes('/')) return null;
  return { anchor: normalized.slice(0, idx), rel: `${WORKTREE_SUBDIR}/${dirName}` };
}

/**
 * The containment anchor for a path inside a task's WORKSPACE, plus the rel prefix that reaches it.
 *
 * A worktree must never be an anchor: it lives under `.haive/`, which the cli-exec sandbox mounts
 * read-write, so its own path components are exactly the ones an agent can redirect. The repository
 * root is the trusted directory, so a worktree resolves to `(repoRoot, '.haive/worktrees/<dir>/')`
 * and everything below is appended to that prefix. A workspace that is NOT a worktree is the repo
 * root already (root-mode and read-only local repos, where `ctx.workspacePath` is the checkout), so
 * it anchors on itself with an empty prefix.
 */
export function workspaceAnchor(workspacePath: string): { anchor: string; prefix: string } {
  const split = splitWorktreePath(workspacePath);
  return split
    ? { anchor: split.anchor, prefix: `${split.rel}/` }
    : { anchor: workspacePath, prefix: '' };
}
