import { isPathContainmentError, readTextNoFollow } from '@haive/shared/fs-safe';
import { gitRun, type GitRunResult } from '../repo/git-push.js';
import { HOST_REPO_ROOT } from '../repo/worktree-git-boundary.js';
import { workspaceAnchor } from '../repo/worktree-paths.js';
import { REPO_IS_DATA_MERGE_LINES, safeRef, safeTitle } from './steps/_untrusted-repo.js';

// Shared git-merge / conflict-resolution core. Extracted from dag-executor.ts so
// both the DAG executor (issue branches -> integration branch) and the
// worktree-cleanup merge phase (feature branch -> base branch) drive an identical
// host-side completion: the fix agent edits the conflicted files in the sandbox
// (git is unavailable there), then the host verifies the markers are gone, stages,
// and commits.

/** True once `branch` is merged into `worktreePath`'s HEAD: an aborted merge also leaves no
 *  MERGE_HEAD and nothing unmerged, so what marks a commit is that the branch is in HEAD. */
export async function mergeCommitted(worktreePath: string, branch: string): Promise<boolean> {
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code === 0) return false; // merge still open (not committed)
  const status = await gitRun(worktreePath, ['--no-optional-locks', 'status', '--porcelain']);
  const unmerged = status.stdout.split('\n').some((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l));
  if (unmerged) return false;
  const ancestor = await gitRun(worktreePath, ['merge-base', '--is-ancestor', branch, 'HEAD']);
  return ancestor.code === 0;
}

function nulPaths(out: string): string[] {
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** The paths still unmerged in `dir`, or null when git could not list them. Read with `-z`: without
 *  it git quotes a name holding a quote or a non-ASCII byte, and the quoted form names no file. */
export async function unmergedPaths(dir: string): Promise<string[] | null> {
  const res = await gitRun(dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return res.code === 0 ? nulPaths(res.stdout) : null;
}

async function revParse(dir: string, spec: string): Promise<string | null> {
  const res = await gitRun(dir, ['rev-parse', '-q', '--verify', spec]);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** True while a merge of `ref` is open in `dir`. */
export async function mergeOpenFor(dir: string, ref: string): Promise<boolean> {
  const head = await revParse(dir, 'MERGE_HEAD');
  return head !== null && head === (await revParse(dir, `${ref}^{commit}`));
}

function gitDetail(res: GitRunResult): string {
  return (res.stderr || res.stdout).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
}

export type MergeOpen =
  { kind: 'merged' } | { kind: 'conflict' } | { kind: 'refused'; detail: string };

/** Merge `ref` into the branch checked out in `dir`. A conflict leaves MERGE_HEAD naming `ref`; a
 *  merge git refused (local changes or an untracked file in the way, a ref it cannot resolve) leaves
 *  none, and exits with the same codes a conflict does. */
export async function openMerge(
  dir: string,
  ref: string,
  flags: string[],
  env: Record<string, string>,
): Promise<MergeOpen> {
  const res = await gitRun(dir, ['merge', '--no-ff', ...flags, ref], env);
  if (res.code === 0) return { kind: 'merged' };
  if (await mergeOpenFor(dir, ref)) return { kind: 'conflict' };
  return { kind: 'refused', detail: gitDetail(res) };
}

export type MergeAbort = { ok: true } | { ok: false; blocking: string[]; detail: string };

/** A person's own checkout, mounted from the host: Haive discards nothing there. */
function isHostCheckout(dir: string): boolean {
  return dir === HOST_REPO_ROOT || dir.startsWith(`${HOST_REPO_ROOT}/`);
}

/** Paths the merge staged and something edited since, which is what makes `merge --abort` refuse. */
async function stagedThenEdited(dir: string): Promise<string[] | null> {
  const [staged, edited, unmerged] = await Promise.all([
    gitRun(dir, ['diff', '--cached', '--name-only', '-z']),
    gitRun(dir, ['diff', '--name-only', '-z']),
    unmergedPaths(dir),
  ]);
  if (staged.code !== 0 || edited.code !== 0 || unmerged === null) return null;
  const changed = new Set(nulPaths(edited.stdout));
  const open = new Set(unmerged);
  return nulPaths(staged.stdout).filter((p) => changed.has(p) && !open.has(p));
}

const RESTORE_CHUNK = 100;

/** End the merge open in `dir`, leaving the tree as the merge found it. `merge --abort` refuses once
 *  a file the merge staged is edited (a fixer's edit to a cleanly merged file), so those edits are
 *  put back from the index and the abort is tried again. In a host checkout nothing is put back and
 *  the paths are reported instead. */
export async function abortMerge(dir: string): Promise<MergeAbort> {
  if ((await revParse(dir, 'MERGE_HEAD')) === null) return { ok: true };
  const first = await gitRun(dir, ['merge', '--abort']);
  if ((await revParse(dir, 'MERGE_HEAD')) === null) return { ok: true };
  const blocking = (await stagedThenEdited(dir)) ?? [];
  if (blocking.length === 0 || isHostCheckout(dir)) {
    return { ok: false, blocking, detail: gitDetail(first) };
  }
  for (let i = 0; i < blocking.length; i += RESTORE_CHUNK) {
    const restore = await gitRun(dir, ['checkout', '--', ...blocking.slice(i, i + RESTORE_CHUNK)], {
      GIT_LITERAL_PATHSPECS: '1',
    });
    if (restore.code !== 0) return { ok: false, blocking, detail: gitDetail(restore) };
  }
  const second = await gitRun(dir, ['merge', '--abort']);
  if ((await revParse(dir, 'MERGE_HEAD')) === null) return { ok: true };
  return {
    ok: false,
    blocking: (await stagedThenEdited(dir)) ?? blocking,
    detail: gitDetail(second),
  };
}

/** Clear the way to open a merge of `ref` in `dir`. A merge open for anything else is a stale
 *  attempt and is aborted, or in a host checkout the person's own, left alone and refused. */
export async function abortOtherMerge(dir: string, ref: string): Promise<MergeAbort> {
  const head = await revParse(dir, 'MERGE_HEAD');
  if (head === null || (await mergeOpenFor(dir, ref))) return { ok: true };
  if (isHostCheckout(dir)) {
    return {
      ok: false,
      blocking: [],
      detail: `a merge of ${head.slice(0, 12)} is already in progress there`,
    };
  }
  return abortMerge(dir);
}

/** One line naming what an abort could not undo, for a halt message. */
export function abortFailureNote(abort: { blocking: string[]; detail: string }): string {
  const shown = abort.blocking.slice(0, 5).map((p) => JSON.stringify(p));
  const more =
    abort.blocking.length > shown.length ? ` and ${abort.blocking.length - shown.length} more` : '';
  const paths =
    shown.length > 0 ? ` (changed after the merge staged them: ${shown.join(', ')}${more})` : '';
  return `The merge could not be aborted${paths}: ${abort.detail || 'git gave no reason'}. It is still open; abort or finish it by hand, then retry.`;
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
    `Conflicting branch: ${safeRef(branch)}${title ? ` (${safeTitle(title)})` : ''}.`,
    '',
    // Its OWN variant, not the coder's. This agent edits files and the host stages and commits
    // the result, so it needs the tree-is-data protection — but the acting variant tells an
    // agent to disregard instructions about how to behave, and `guidance` below is exactly
    // that AND legitimate: merge-resolver asks the USER how to resolve the conflict and passes
    // the answer through. "Take ours for the generated file" is behavioural, human and
    // authoritative, so the coder text would have pitted the guard against the operator.
    //
    // Spread rather than joined: this array is NOT `.filter(Boolean)`-ed, so blank lines live.
    ...REPO_IS_DATA_MERGE_LINES,
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
  branch: string,
): Promise<boolean> {
  // Fast path: already committed (e.g. an environment where git did work).
  if (await mergeCommitted(worktreePath, branch)) return true;
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code !== 0) return false; // merge no longer open and not committed
  const files = await unmergedPaths(worktreePath);
  if (files === null) return false;
  // The worktree is under `.haive/`, which the sandbox mounts read-write, so it is SPLIT rather
  // than used as the anchor: every path git reported is walked a component at a time.
  const { anchor, prefix } = workspaceAnchor(worktreePath);
  for (const f of files) {
    // A name that is not UTF-8 decodes to one naming no file, which would read as deleted.
    if (f.includes('\uFFFD')) return false;
    let content: string | null;
    try {
      content = await readTextNoFollow(anchor, `${prefix}${f}`, { strict: true });
    } catch (err) {
      // A REFUSAL must not collapse into the `null` below, which means "deleted as part of the
      // resolution" and lets the commit proceed: a path we cannot read is one whose conflict
      // markers we cannot check, so the merge stays incomplete instead. Every other read failure
      // keeps its old meaning, since `.catch(() => null)` treated those as resolved-by-deletion.
      if (isPathContainmentError(err)) return false;
      content = null;
    }
    if (content === null) continue; // deleted as part of the resolution
    if (/^(<{7}|>{7})( |$)/m.test(content)) return false; // markers remain
  }
  const add = await gitRun(worktreePath, ['add', '-A']);
  if (add.code !== 0) return false;
  const commit = await gitRun(worktreePath, ['commit', '--no-edit'], gitEnv);
  if (commit.code !== 0) return false;
  return mergeCommitted(worktreePath, branch);
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
