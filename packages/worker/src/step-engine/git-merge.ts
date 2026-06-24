import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gitRun } from '../repo/git-push.js';

// Shared git-merge / conflict-resolution core. Extracted from dag-executor.ts so
// both the DAG executor (issue branches -> integration branch) and the
// worktree-cleanup merge phase (feature branch -> base branch) drive an identical
// host-side completion: the fix agent edits the conflicted files in the sandbox
// (git is unavailable there), then the host verifies the markers are gone, stages,
// and commits.

/** True once a live merge in `worktreePath` is committed with no unmerged paths
 *  (MERGE_HEAD gone). */
export async function mergeCommitted(worktreePath: string): Promise<boolean> {
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code === 0) return false; // merge still open (not committed)
  const status = await gitRun(worktreePath, ['status', '--porcelain']);
  const unmerged = status.stdout.split('\n').some((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l));
  return !unmerged;
}

/** Build the conflict-resolution agent's prompt. `title` is an optional
 *  human-readable label for the branch; `guidance` is the user's free-text answer
 *  to a prior clarification (omitted when none). The static instructions are the
 *  contract the host relies on — the agent edits files only, the host stages and
 *  commits afterward. */
export function buildMergeFixPrompt(branch: string, title?: string, guidance?: string): string {
  return [
    'A git merge conflict occurred while merging an implemented issue branch into the integration branch.',
    'Your working directory is the integration worktree, MID-MERGE — the conflict markers are live in the files.',
    `Conflicting branch: ${branch}${title ? ` (${title})` : ''}.`,
    ...(guidance ? ['', `User guidance for resolving this conflict: ${guidance}`] : []),
    '',
    'Resolve EVERY conflict by EDITING the conflicted files: remove the <<<<<<< / ======= / >>>>>>> markers',
    "and combine both sides as the implementation intends; don't drop either side's work.",
    'Do NOT run git — it is unavailable in this environment; the orchestrator stages and commits the merge',
    'after you finish. Do NOT run tests or any other commands.',
    'When every conflict marker is gone from the files, stop.',
  ].join('\n');
}

/** Complete a mid-merge in `worktreePath` after a fix agent edited the conflicted
 *  files. The agent cannot run git (the worktree's absolute gitdir path does not
 *  exist inside the sandbox), so the host verifies no conflict markers remain in
 *  the previously-unmerged paths, stages, and commits. Returns true when the merge
 *  commit landed. */
export async function completeMergeHostSide(
  worktreePath: string,
  gitEnv: Record<string, string>,
): Promise<boolean> {
  // Fast path: already committed (e.g. an environment where git did work).
  if (await mergeCommitted(worktreePath)) return true;
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code !== 0) return false; // merge no longer open and not committed
  const unmerged = await gitRun(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  const files = unmerged.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of files) {
    const content = await readFile(path.join(worktreePath, f), 'utf8').catch(() => null);
    if (content === null) continue; // deleted as part of the resolution
    if (/^(<{7}|>{7})( |$)/m.test(content)) return false; // markers remain
  }
  const add = await gitRun(worktreePath, ['add', '-A']);
  if (add.code !== 0) return false;
  const commit = await gitRun(worktreePath, ['commit', '--no-edit'], gitEnv);
  if (commit.code !== 0) return false;
  return mergeCommitted(worktreePath);
}
