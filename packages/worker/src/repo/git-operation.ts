import { isAbsolute, relative, resolve } from 'node:path';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { GIT_OPERATION_STATE_ENTRIES } from '@haive/shared/git-args';
import { gitRun } from './git-exec.js';
import { gitWorkspaceStatus } from './git-workspace.js';

/** A checkout with a `.git` whose merge, rebase, cherry-pick or revert state could not be read. */
export class GitOperationUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitOperationUnreadableError';
  }
}

/** Whether a merge, rebase, cherry-pick or revert is open: its state entry in the git dir exists. `rev-parse --verify`
 *  would also resolve a branch or tag named MERGE_HEAD; a rebase stopped at an `exec` has its state
 *  directory but no REBASE_HEAD. A checkout with no `.git` has none; a read that fails in one that has
 *  a `.git` is unknown and throws. */
export async function gitOperationInProgress(
  repoPath: string,
  anchor = repoPath,
): Promise<boolean> {
  return (await gitOperationMarker(repoPath, anchor)) !== null;
}

/** The first state entry that holds this checkout, using the same read as the operation guard.
 * A caller inspecting a linked worktree may supply its trusted repository root as anchor;
 * git state outside that root is still unreadable. Never use a git-provided path as anchor. */
export async function gitOperationMarker(
  repoPath: string,
  anchor = repoPath,
): Promise<string | null> {
  for (const ref of GIT_OPERATION_STATE_ENTRIES) {
    const located = await gitRun(repoPath, ['rev-parse', '--git-path', ref]);
    if (located.code !== 0) {
      if ((await gitWorkspaceStatus(repoPath)) === 'absent') return null;
      throw new GitOperationUnreadableError(
        `git rev-parse --git-path ${ref} failed in ${repoPath}: ${(located.stderr || located.stdout).trim().slice(0, 500)}`,
      );
    }
    const path = located.stdout.trim();
    if (!path) continue;
    const rel = relative(anchor, isAbsolute(path) ? path : resolve(repoPath, path));
    // The checkout anchor cannot inspect state outside it; that proves no operation either way.
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      throw new GitOperationUnreadableError(`${ref} is outside the checkout anchor in ${repoPath}`);
    }
    try {
      if ((await lstatNoFollow(anchor, rel, { strict: true })) !== null) return ref;
    } catch (err) {
      throw new GitOperationUnreadableError(
        `${ref} could not be read in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}
