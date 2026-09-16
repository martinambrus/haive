import { applyTreeNoFollow, lstatNoFollow } from '@haive/shared/fs-safe';
import { SANDBOX_GID, SANDBOX_UID } from '../sandbox/sandbox-identity.js';

export type SandboxWritableTreeRepair =
  'none' | 'chown' | 'chmod-owner' | 'chmod-other' | 'unavailable';

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
 * ownership and owner permissions. A non-root worker may chmod a tree it owns
 * so the fixed sandbox uid can access it (notably GitHub's uid-1001 runner). */
export function sandboxWritableTreeRepair(
  root: TreeRootStat,
  workerUid: number | undefined,
): SandboxWritableTreeRepair {
  if (isSandboxWritableTreeRoot(root)) return 'none';
  if (!root.isDirectory()) return 'unavailable';
  if (workerUid === 0) return 'chown';
  if (workerUid !== undefined && root.uid === workerUid) {
    // A uid-1000 worker and the sandbox are the same identity. Granting `other`
    // access would not help because the kernel selects the matching owner class.
    return workerUid === SANDBOX_UID ? 'chmod-owner' : 'chmod-other';
  }
  return 'unavailable';
}

const RWX = {
  owner: { rw: 0o600, x: 0o100 },
  other: { rw: 0o006, x: 0o001 },
} as const;

/** GNU's `u+rwX` / `o+rwX` as a per-entry function, over one or more permission classes. Uppercase
 *  X is the part that matters: it adds traversal to a directory and to an already-executable file,
 *  and leaves a plain source file non-executable — a blanket `+x` would mark every file in the
 *  checkout executable. */
const addRwX =
  (...classes: ('owner' | 'other')[]) =>
  (mode: number, isDir: boolean): number => {
    // Decided from the ORIGINAL mode, so granting one class cannot make the next class executable.
    const executable = isDir || (mode & 0o111) !== 0;
    let next = mode;
    for (const cls of classes) {
      next |= RWX[cls].rw;
      if (executable) next |= RWX[cls].x;
    }
    return next;
  };

/**
 * Make a repository/worktree tree writable by the cli-exec sandbox user.
 *
 * Takes `(anchor, rel)`: the anchor is the repository root, whose parents are the worker's own,
 * and `rel` is walked one held descriptor at a time, so a link committed anywhere under it is
 * refused rather than repaired through. That replaces a recursive `chown`/`chmod` shell-out whose
 * behaviour differed between the BusyBox in the shipped image and the GNU coreutils on CI.
 *
 * The worker creates linked worktrees as root but runs agents as uid 1000. Do
 * not cache this result in the repository: an in-tree marker can be committed,
 * copied into a newly-created root-owned worktree, and falsely claim the new
 * checkout was already repaired. Inspect the actual mount root instead.
 *
 * This is intentionally fail-closed. Dispatching an agent into an unwritable
 * tree wastes a model call and can later be mistaken for implementation debt.
 */
export async function ensureSandboxWritableTree(anchor: string, rel: string): Promise<void> {
  const shown = rel === '' ? anchor : `${anchor}/${rel}`;
  const before = await lstatNoFollow(anchor, rel, { strict: true });
  if (before === null) {
    throw new Error(`workspace ${shown} does not exist, so its sandbox access cannot be repaired`);
  }
  const workerUid = process.getuid?.();
  const repair = sandboxWritableTreeRepair(before.stats, workerUid);
  if (repair === 'none') return;
  if (repair === 'unavailable') {
    throw new Error(
      `workspace ${shown} is uid ${before.stats.uid}:${before.stats.gid} mode ${(before.stats.mode & 0o777).toString(8)}, ` +
        `but the sandbox runs as ${SANDBOX_UID}:${SANDBOX_GID} and worker uid ${workerUid ?? 'unknown'} cannot repair its access`,
    );
  }

  try {
    if (repair === 'chown') {
      // Owner and mode in ONE walk, owner first per entry. Ownership alone is not sufficient:
      // an app running inside DDEV can chmod the mounted project root (a legacy installer has
      // produced mode 0200 in practice), which leaves the owner correct while neither the sandbox
      // nor DDEV can read or traverse the checkout.
      await applyTreeNoFollow(anchor, rel, {
        owner: { uid: SANDBOX_UID, gid: SANDBOX_GID },
        mode: addRwX('owner'),
      });
    } else if (repair === 'chmod-owner') {
      await applyTreeNoFollow(anchor, rel, { mode: addRwX('owner') });
    } else {
      // The non-root worker owns this checkout but cannot chown it to uid 1000. Grant the `other`
      // class, which is the class the kernel matches for the otherwise-unrelated sandbox identity —
      // and the OWNER class as well, because the kernel matches THAT one for this process. Granting
      // `other` alone leaves a tree whose owner bits were stripped unwritable by the very worker
      // that just reported repairing it, while the root-only verdict below still passes. MEASURED
      // on a uid-1001 runner: a 0500 directory became 0507, so the owner kept r-x and could not
      // unlink inside it. The shell-out this replaces had the same hole and never surfaced it,
      // because nothing verified anything below the tree root.
      await applyTreeNoFollow(anchor, rel, { mode: addRwX('owner', 'other') });
    }
  } catch (err) {
    const operation = repair === 'chown' ? 'chown/chmod' : 'chmod';
    throw new Error(
      `failed to ${operation} workspace ${shown} for sandbox ${SANDBOX_UID}:${SANDBOX_GID}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const after = await lstatNoFollow(anchor, rel, { strict: true });
  if (after === null || !isSandboxWritableTreeRoot(after.stats)) {
    const detail = after
      ? `(uid ${after.stats.uid}:${after.stats.gid}, mode ${(after.stats.mode & 0o777).toString(8)})`
      : '(it no longer exists)';
    throw new Error(`workspace ${repair} repair did not make ${shown} sandbox-writable ${detail}`);
  }
}
