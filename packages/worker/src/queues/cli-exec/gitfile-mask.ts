import { join, posix } from 'node:path';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { SANDBOX_WORKDIR, type SandboxExtraFile } from '../../sandbox/sandbox-runner.js';
import { WORKER_REPO_STORAGE_ROOT } from '../../repo/worktree-git-boundary.js';

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
 * exists only in the container. The app runtime (app-runner/ddev) mounts the same tree
 * WITHOUT this mask, so the running app's own tooling keeps working there.
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

export interface GitDataBoundary {
  /** A read-only view of the repository's real `.git`, nested under the repo mount. */
  mounts: DockerVolumeMount[];
  /** The empty-file mask, for a `.git` that is not a directory. */
  masks: SandboxExtraFile[];
}

const NOTHING: GitDataBoundary = { mounts: [], masks: [] };

/**
 * The same boundary for an invocation mounted at the repository ROOT, where `.git` is a real
 * directory: mount it back over itself READ-ONLY.
 *
 * A worktree invocation sees only its own subtree, but every invocation of a task with no
 * worktree gets the whole checkout read-write — every onboarding step, the steps before
 * `01-worktree-setup`, every plan task, a `kb_author` task with a repository, and every
 * same-branch merge fixer. `.git/hooks` and `.git/config` are uid 1000 there, the sandbox user,
 * and host-side git later runs in that tree as root. Nothing an agent is asked to do needs a
 * writable `.git`: every prompt already says the host stages and commits, and the one step that
 * asks for git asks for `ls-files`, `log` and `show` (`07_7-secret-sweep`).
 *
 * The mechanism is the one `resolveTaskUploadsMount` already relies on — a repos-volume subpath
 * mounted read-only UNDER the repository mount — so docker needs nothing new.
 *
 * Three shapes, decided by ONE no-follow lstat, because what stands at `.git` varies:
 *
 * - a directory — the read-only mount;
 * - anything else (a gitfile, a link) — the empty-file mask above, since a mount cannot express
 *   a link and an unreadable gitfile is what the worktree case already hands an agent;
 * - absent — NOTHING. Docker refuses a subpath that does not exist, and a read-only tmpfs over a
 *   missing destination makes docker materialise a root-owned stub that outlives the container
 *   (see `agent-definition-mask.ts`), which would flip `hasWorkspaceEntry('.git')` and break the
 *   `git init` that `12-post-onboarding` performs on a repository that has no git yet. A
 *   repository with no `.git` has nothing to protect, and host git executing nothing a
 *   repository's config names is what makes a `.git` that appears there harmless.
 */
export async function repoGitDataBoundary(
  repoMount: DockerVolumeMount | null,
  opts: { hasWorktree: boolean; hasRepo: boolean },
): Promise<GitDataBoundary> {
  if (opts.hasWorktree) return { mounts: [], masks: worktreeGitfileMask(true) };
  // A read-only local-path repository is bound `:ro` whole, and a repo-less task's scratch
  // workspace has no git; `hasRepo` is what tells the second from a repository root.
  if (!opts.hasRepo || !repoMount?.subpath) return NOTHING;
  // The subpath of a non-worktree invocation IS `<userId>/<repositoryId>`, the anchor every
  // fs-safe read of a repository uses.
  const entry = await lstatNoFollow(join(WORKER_REPO_STORAGE_ROOT, repoMount.subpath), '.git');
  if (entry === null) return NOTHING;
  if (entry.kind !== 'directory') return { mounts: [], masks: worktreeGitfileMask(true) };
  return {
    mounts: [
      {
        source: repoMount.source,
        // Derived from the mount rather than from SANDBOX_WORKDIR: a cli-exec sandbox mounts the
        // tree at the workdir, the browser IDE at `/workspace`, and the `.git` mount has to land
        // inside whichever one it is nested in.
        target: posix.join(repoMount.target, '.git'),
        subpath: `${repoMount.subpath}/.git`,
        readOnly: true,
      },
    ],
    masks: [],
  };
}
