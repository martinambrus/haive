import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { SANDBOX_GID, SANDBOX_UID } from '../sandbox/sandbox-identity.js';

const exec = promisify(execFile);

export type SandboxWritableTreeRepair = 'none' | 'chown' | 'chmod-other' | 'unavailable';

interface TreeRootStat {
  uid: number;
  gid: number;
  mode: number;
  isDirectory(): boolean;
}

/**
 * True when the cli-exec uid can write and traverse the tree root through its
 * owner, group, or other mode bits. A fresh `git worktree add` made by the root
 * worker is root:root 755, so this O(1) check reliably distinguishes an
 * unrepaired checkout without trusting a marker inside repository content.
 */
export function isSandboxWritableTreeRoot(root: TreeRootStat): boolean {
  if (!root.isDirectory()) return false;
  if (root.uid === SANDBOX_UID) return (root.mode & 0o300) === 0o300;
  if (root.gid === SANDBOX_GID) return (root.mode & 0o030) === 0o030;
  return (root.mode & 0o003) === 0o003;
}

/** Select a repair available to this worker process. Root can normalize
 * ownership. A non-root worker may chmod a tree it owns so the fixed sandbox
 * uid can access it (notably GitHub's uid-1001 runner). */
export function sandboxWritableTreeRepair(
  root: TreeRootStat,
  workerUid: number | undefined,
): SandboxWritableTreeRepair {
  if (isSandboxWritableTreeRoot(root)) return 'none';
  if (!root.isDirectory()) return 'unavailable';
  if (workerUid === 0) return 'chown';
  if (workerUid !== undefined && root.uid === workerUid) return 'chmod-other';
  return 'unavailable';
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
  const workerUid = process.getuid?.();
  const repair = sandboxWritableTreeRepair(before, workerUid);
  if (repair === 'none') return;
  if (repair === 'unavailable') {
    throw new Error(
      `workspace ${treePath} is uid ${before.uid}:${before.gid} mode ${(before.mode & 0o777).toString(8)}, ` +
        `but the sandbox runs as ${SANDBOX_UID}:${SANDBOX_GID} and worker uid ${workerUid ?? 'unknown'} cannot repair its access`,
    );
  }

  try {
    if (repair === 'chown') {
      await exec('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_GID}`, treePath]);
    } else {
      // The non-root worker owns this checkout but cannot chown it to uid 1000.
      // Grant the `other` class (which includes the otherwise-unmatched sandbox
      // identity) recursive rwX access. Uppercase X adds directory traversal
      // without making ordinary source files executable.
      await exec('chmod', ['-R', 'o+rwX', treePath]);
    }
  } catch (err) {
    throw new Error(
      `failed to ${repair === 'chown' ? 'chown' : 'chmod'} workspace ${treePath} for sandbox ${SANDBOX_UID}:${SANDBOX_GID}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const after = await stat(treePath);
  if (!isSandboxWritableTreeRoot(after)) {
    throw new Error(
      `workspace ${repair} repair did not make ${treePath} sandbox-writable ` +
        `(uid ${after.uid}:${after.gid}, mode ${(after.mode & 0o777).toString(8)})`,
    );
  }
}
