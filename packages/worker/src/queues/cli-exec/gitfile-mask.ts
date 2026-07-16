import { posix } from 'node:path';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';

/**
 * Read-only empty-file mask over a linked worktree's `.git` gitfile inside the
 * cli-exec sandbox.
 *
 * The task-aware dispatcher pairs this mask with the shared worktree git-boundary
 * prompt: it explains that the zero-byte `.git` entry is an intentional containment
 * sentinel, forbids repairing it, and says the host stages and commits. Both use the
 * same invocation-target predicate, so a prompt cannot claim this boundary for the
 * repo root and a masked worktree cannot omit it.
 *
 * Before the mask existed, the gitfile held a host-absolute gitdir that did not
 * resolve inside the container, so git merely errored. An agent repointed it at the
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
