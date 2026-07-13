import { posix } from 'node:path';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';

/**
 * Read-only empty-file mask over a linked worktree's `.git` gitfile inside the
 * cli-exec sandbox.
 *
 * Every agent prompt asserts that git is unavailable in the sandbox and that the
 * host stages and commits (10-gate-3-commit, completeMergeHostSide). That was only
 * true by accident: the gitfile holds a host-absolute gitdir that does not resolve
 * inside the container, so git merely errored. An agent repointed it at the
 * container path — `printf 'gitdir: /haive/workdir/.git/worktrees/<name>' > .git` —
 * which handed itself a working git behind the commit gate AND left host-side git
 * fatally broken for every later step of the task (task 82949225).
 *
 * The read-only bind makes the invariant real rather than incidental: the rewrite
 * fails (read-only mount), the file cannot be unlinked to replace it (mount is
 * busy), and git reports `fatal: invalid gitfile format` — it does not fall back to
 * discovering the parent repo. The host's real gitfile is never touched; the mount
 * exists only in the container. The app runtime (app-runner/ddev), the task terminal
 * and the browser IDE mount the same tree WITHOUT this mask, so user-facing git
 * keeps working there.
 *
 * The worktree is mounted ALONE at SANDBOX_WORKDIR, so its `.git` gitfile sits at
 * SANDBOX_WORKDIR/.git — mask that whenever a worktree is mounted. No mask when no
 * worktree is in play (the repo root — `.git` is a directory there, not a gitfile).
 * Driven off an explicit hasWorktree flag: keying on `workdir === SANDBOX_WORKDIR`
 * would silently disable the mask now that the worktree IS the workdir root.
 */
export function worktreeGitfileMask(hasWorktree: boolean): SandboxExtraFile[] {
  if (!hasWorktree) return [];
  return [{ containerPath: posix.join(SANDBOX_WORKDIR, '.git'), content: '' }];
}
