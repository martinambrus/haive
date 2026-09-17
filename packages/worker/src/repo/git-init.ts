import { updateFileNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from './git-push.js';

/** Haive-internal per-repo data (`.haive/worktrees/`, `.haive/install.json`) is kept out
 *  of the index via `.git/info/exclude` rather than `.gitignore`, so the user's ignore
 *  file stays theirs. Curated deliverables under it are force-added (`git add -f`). */
export const GIT_EXCLUDE_MARKER = '.haive/';

/** Append the `.haive/` entry to `.git/info/exclude`. Idempotent. */
export async function ensureGitExcludeEntry(repoPath: string): Promise<void> {
  // One descriptor for the read and the write, and every component of `.git/info/exclude` is walked
  // without being followed. That matters here even though `.git` is not repository CONTENT: a repo
  // can ship a `.git` that is a gitfile or a link, and this now refuses loudly instead of writing
  // through it. Returning `null` from the updater means the marker is already present — no write,
  // so the function stays idempotent without a separate existence probe.
  await updateFileNoFollow(
    repoPath,
    '.git/info/exclude',
    (current) => {
      const content = current ?? '';
      if (content.split('\n').some((line) => line.trim() === GIT_EXCLUDE_MARKER)) return null;
      const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      return `${content}${suffix}${GIT_EXCLUDE_MARKER}\n`;
    },
    { create: true, createParents: true },
  );
}

/** `git init -b <branch>` plus the `.haive/` exclude entry. Deliberately does NOT stage
 *  or commit: callers differ on what the first commit holds. The exclude entry is written
 *  before any `git add` so the internal marker never becomes tracked (a tracked marker
 *  reappears in every linked worktree). */
export async function initGitWorkspace(repoPath: string, branch: string): Promise<void> {
  const init = await gitRun(repoPath, ['init', '-b', branch]);
  if (init.code !== 0) {
    throw new Error(`git init failed (exit ${init.code}): ${init.stderr || init.stdout}`);
  }
  await ensureGitExcludeEntry(repoPath);
}
