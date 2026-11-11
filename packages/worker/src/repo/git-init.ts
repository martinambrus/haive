import { updateFileNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from './git-push.js';

/** Haive-internal per-repo data (`.haive/worktrees/`) is kept out
 *  of the index via `.git/info/exclude` rather than `.gitignore`, so the user's ignore
 *  file stays theirs. Curated deliverables under it are force-added (`git add -f`). */
export const GIT_EXCLUDE_MARKER = '.haive/';

/** Claude Code's "Yes, and don't ask again" writes the approved command verbatim, secrets
 *  included, into `.claude/settings.local.json` under the directory it runs in. A person
 *  running `claude` in the task terminal creates one in the worktree, and every commit Haive
 *  makes stages with `git add -A`, so a repository that does not ignore it would commit it.
 *  An ignore entry leaves a copy the repository already tracks alone. */
export const CLAUDE_LOCAL_SETTINGS_EXCLUDE = '**/.claude/settings.local.json';

const GIT_EXCLUDE_ENTRIES = [GIT_EXCLUDE_MARKER, CLAUDE_LOCAL_SETTINGS_EXCLUDE];

/** Append each missing entry of `GIT_EXCLUDE_ENTRIES` to `.git/info/exclude`. Idempotent. */
export async function ensureGitExcludeEntry(repoPath: string): Promise<void> {
  // One descriptor for the read and the write, and every component of `.git/info/exclude` is walked
  // without being followed. That matters here even though `.git` is not repository CONTENT: a repo
  // can ship a `.git` that is a gitfile or a link, and this now refuses loudly instead of writing
  // through it. Returning `null` from the updater means every entry is already present — no write,
  // so the function stays idempotent without a separate existence probe.
  await updateFileNoFollow(
    repoPath,
    '.git/info/exclude',
    (current) => {
      const content = current ?? '';
      const present = new Set(content.split('\n').map((line) => line.trim()));
      const missing = GIT_EXCLUDE_ENTRIES.filter((entry) => !present.has(entry));
      if (missing.length === 0) return null;
      const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      return `${content}${suffix}${missing.map((entry) => `${entry}\n`).join('')}`;
    },
    { create: true, createParents: true },
  );
}

/** `git init -b <branch>` plus the exclude entries. Deliberately does NOT stage
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
