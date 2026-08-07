import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitRun } from './git-push.js';

/** Haive-internal per-repo data (`.haive/worktrees/`, `.haive/install.json`) is kept out
 *  of the index via `.git/info/exclude` rather than `.gitignore`, so the user's ignore
 *  file stays theirs. Curated deliverables under it are force-added (`git add -f`). */
export const GIT_EXCLUDE_MARKER = '.haive/';

/** Append the `.haive/` entry to `.git/info/exclude`. Idempotent. */
export async function ensureGitExcludeEntry(repoPath: string): Promise<void> {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
  await mkdir(path.dirname(excludePath), { recursive: true });
  let content = '';
  try {
    content = await readFile(excludePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const lines = content.split('\n').map((line) => line.trim());
  if (lines.includes(GIT_EXCLUDE_MARKER)) return;
  const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await writeFile(excludePath, `${content}${suffix}${GIT_EXCLUDE_MARKER}\n`, 'utf8');
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
