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

/** Collapse a merge that has ALREADY landed in `worktreePath` into a single commit on
 *  the current branch: `reset --soft` back to the pre-merge tip, then one commit of the
 *  merged index. The tree is unchanged — only the history is.
 *
 *  Deliberately NOT `git merge --squash`, which never writes MERGE_HEAD: the whole
 *  conflict loop is built on that file (completeMergeHostSide requires it, and
 *  `git merge --abort` fails without it), so squashing at merge time would break
 *  conflict resolution and leave a conflicted index behind. Merging normally and
 *  collapsing afterwards leaves every one of those paths untouched.
 *
 *  Returns the new commit's sha, or null when there was nothing to collapse. Safe to
 *  re-enter after a crash: a half-done attempt (HEAD already reset, changes staged)
 *  finishes with the commit, and a completed one collapses to an identical tree again.
 *
 *  Never touches a LIVE merge — the conflict loop owns that until its own commit lands. */
export async function squashMergeCommit(
  worktreePath: string,
  baseShaBefore: string,
  message: string,
  gitEnv: Record<string, string>,
): Promise<string | null> {
  const open = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (open.code === 0) return null;
  const head = await gitRun(worktreePath, ['rev-parse', 'HEAD']);
  if (head.code !== 0) return null;

  if (head.stdout.trim() !== baseShaBefore) {
    const reset = await gitRun(worktreePath, ['reset', '--soft', baseShaBefore]);
    if (reset.code !== 0) {
      throw new Error(
        `git reset --soft ${baseShaBefore} failed: ${reset.stderr || reset.stdout}`.trim(),
      );
    }
  }
  // Nothing staged: the merge was a no-op ("Already up to date"), so there is no
  // history to collapse. `git diff --cached --quiet` exits non-zero when it differs.
  const staged = await gitRun(worktreePath, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return null;

  const commit = await gitRun(worktreePath, ['commit', '-m', message], gitEnv);
  if (commit.code !== 0) {
    throw new Error(`git commit (squash) failed: ${commit.stderr || commit.stdout}`.trim());
  }
  const sha = await gitRun(worktreePath, ['rev-parse', 'HEAD']);
  return sha.code === 0 ? sha.stdout.trim() : null;
}
