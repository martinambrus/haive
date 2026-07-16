import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { SANDBOX_GID, SANDBOX_UID } from '../sandbox/sandbox-identity.js';

const exec = promisify(execFile);

/**
 * True when the tree root is owned by the uid used by cli-exec and its owner
 * write + execute bits are set. (The gid need not match when the uid owns it.)
 * A fresh `git worktree add` made by the root worker is
 * root:root, so this O(1) check reliably distinguishes an unrepaired checkout
 * without trusting a marker inside repository content.
 */
export function isSandboxWritableTreeRoot(root: {
  uid: number;
  gid: number;
  mode: number;
  isDirectory(): boolean;
}): boolean {
  return root.isDirectory() && root.uid === SANDBOX_UID && (root.mode & 0o300) === 0o300;
}

/**
 * Make a repository/worktree tree writable by the cli-exec sandbox user.
 *
 * The worker creates linked worktrees as root but runs agents as uid 1000. Do
 * not cache this result in the repository: an in-tree marker can be committed,
 * copied into a newly-created root-owned worktree, and falsely claim the new
 * checkout was already repaired. Inspect the actual mount root instead.
 *
 * This is intentionally fail-closed. Dispatching an agent into an unwritable
 * tree wastes a model call and can later be mistaken for implementation debt.
 */
export async function ensureSandboxWritableTree(treePath: string): Promise<void> {
  const before = await stat(treePath);
  if (isSandboxWritableTreeRoot(before)) return;

  const workerUid = process.getuid?.();
  if (workerUid !== 0) {
    throw new Error(
      `workspace ${treePath} is uid ${before.uid}:${before.gid} mode ${(before.mode & 0o777).toString(8)}, ` +
        `but the sandbox runs as ${SANDBOX_UID}:${SANDBOX_GID} and worker uid ${workerUid ?? 'unknown'} cannot repair ownership`,
    );
  }

  try {
    await exec('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, treePath]);
  } catch (err) {
    throw new Error(
      `failed to chown workspace ${treePath} to ${SANDBOX_UID}:${SANDBOX_GID}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const after = await stat(treePath);
  if (!isSandboxWritableTreeRoot(after)) {
    throw new Error(
      `workspace ownership repair did not make ${treePath} sandbox-writable ` +
        `(uid ${after.uid}:${after.gid}, mode ${(after.mode & 0o777).toString(8)})`,
    );
  }
}
