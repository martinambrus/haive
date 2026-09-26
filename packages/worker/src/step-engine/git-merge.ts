import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { schema, type Database } from '@haive/database';
import {
  isPathContainmentError,
  lstatNoFollow,
  readTextNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { ensureGitExcludeEntry } from '../repo/git-init.js';
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

const PATHSPEC_CHUNK = 100;

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
  for (let i = 0; i < blocking.length; i += PATHSPEC_CHUNK) {
    const restore = await gitRun(
      dir,
      ['checkout', '--', ...blocking.slice(i, i + PATHSPEC_CHUNK)],
      { GIT_LITERAL_PATHSPECS: '1' },
    );
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

/** What a merge dir held when a fixer was sent in: the whole worktree as one git tree, untracked
 *  files included, the paths the fixer was sent to resolve, and the merge it was sent into. */
export interface FixBaseline {
  tree: string;
  unmerged: string[];
  head: string;
  mergeHead: string;
}

/** The worktree as one git tree, untracked files included. Built in a scratch index, since the
 *  merge's own index holds the conflict. */
async function snapshotTree(dir: string): Promise<string | null> {
  const name = `haive-merge-snapshot-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  try {
    if ((await gitRun(dir, ['read-tree', 'HEAD'], env)).code !== 0) return null;
    if ((await gitRun(dir, ['add', '-A'], env)).code !== 0) return null;
    const tree = await gitRun(dir, ['write-tree'], env);
    return tree.code === 0 ? tree.stdout.trim() : null;
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
  }
}

/** Record the tree before a fixer is sent into it, so what the fixer changes outside the conflict
 *  can be told from the merge and from what stood there already. Null when there is nothing to
 *  record: a person's own checkout, which the sandbox mounts read-only, or a tree git cannot read. */
export async function captureFixBaseline(dir: string): Promise<FixBaseline | null> {
  if (isHostCheckout(dir)) return null;
  // `.haive/` holds other tasks' worktrees and earlier leftovers; excluded, no snapshot reads them.
  await ensureGitExcludeEntry(workspaceAnchor(dir).anchor).catch(() => undefined);
  const [head, mergeHead, unmerged] = await Promise.all([
    revParse(dir, 'HEAD'),
    revParse(dir, 'MERGE_HEAD'),
    unmergedPaths(dir),
  ]);
  if (head === null || mergeHead === null || unmerged === null) return null;
  const tree = await snapshotTree(dir);
  return tree === null ? null : { tree, unmerged, head, mergeHead };
}

export interface FixerLeftovers {
  /** The attempt's folder, relative to the repository root. */
  folder: string;
  moved: string[];
  /** Changes still in the tree, with why. */
  left: { path: string; reason: string }[];
  /** Set when git could not say what the fixer changed, so nothing was moved. */
  unchecked?: string;
}

export const MERGE_LEFTOVERS_DIR = '.haive/merge-leftovers';
const GITLINK_MODE = '160000';

/** Haive's own directories, which other writers keep: a relocation never touches them. */
function haiveOwned(p: string): boolean {
  return p === '.haive' || p.startsWith('.haive/') || p.startsWith('.haive-data/');
}

/** `diff-tree -r -z` raw records; `--no-renames` keeps each to one path. */
function rawChanges(
  out: string,
): { srcMode: string; dstMode: string; status: string; path: string }[] {
  const parts = out.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length && parts[i]!.startsWith(':'); i += 2) {
    const [srcMode = '', dstMode = '', , , status = ''] = parts[i]!.slice(1).split(' ');
    changes.push({ srcMode, dstMode, status: status.charAt(0), path: parts[i + 1]! });
  }
  return changes;
}

/** Move what a fixer changed outside the paths it was sent to resolve out of `dir`, into
 *  `<folder>/files/`, and put those paths back as the baseline had them, so neither the next fixer
 *  nor the merge commit inherits them. A path that cannot be moved (a link, a name git could not
 *  decode) stays in the tree and is reported. The index is refreshed after the restore, since git
 *  rewrites the files and `merge --abort` refuses an entry whose stat data no longer matches. */
export async function relocateFixerChanges(
  dir: string,
  baseline: FixBaseline | null | undefined,
  run: { taskId: string; runId: string },
): Promise<FixerLeftovers | null> {
  if (!baseline || isHostCheckout(dir)) return null;
  const folder = `${MERGE_LEFTOVERS_DIR}/${run.taskId}/${run.runId}`;
  // Once the merge was finished or aborted by hand the baseline no longer describes the tree, and
  // putting its paths back would write merged files into a tree with no merge open.
  if (
    (await revParse(dir, 'HEAD')) !== baseline.head ||
    (await revParse(dir, 'MERGE_HEAD')) !== baseline.mergeHead
  ) {
    return {
      folder,
      moved: [],
      left: [],
      unchecked: 'the merge it was sent into is no longer open',
    };
  }
  const after = await snapshotTree(dir);
  if (after === null) {
    return { folder, moved: [], left: [], unchecked: 'git could not read the tree' };
  }
  if (after === baseline.tree) return null;
  const diff = await gitRun(dir, ['diff-tree', '-r', '-z', '--no-renames', baseline.tree, after]);
  if (diff.code !== 0) return { folder, moved: [], left: [], unchecked: gitDetail(diff) };
  const { anchor, prefix } = workspaceAnchor(dir);
  const root = await lstatNoFollow(anchor, '', { strict: true }).catch(() => null);
  const owner = root ? { uid: root.stats.uid, gid: root.stats.gid } : undefined;
  const conflicted = new Set(baseline.unmerged);
  const moved: string[] = [];
  const left: FixerLeftovers['left'] = [];
  const restore: string[] = [];
  for (const c of rawChanges(diff.stdout)) {
    if (conflicted.has(c.path) || haiveOwned(c.path)) continue;
    if (c.srcMode === GITLINK_MODE || c.dstMode === GITLINK_MODE) continue;
    if (c.path.includes('\uFFFD')) {
      left.push({ path: c.path, reason: 'its name is not UTF-8' });
      continue;
    }
    if (c.status !== 'D') {
      try {
        await renameNoFollow(anchor, `${prefix}${c.path}`, `${folder}/files/${c.path}`, {
          noReplace: true,
          createParents: true,
          owner,
        });
        moved.push(c.path);
      } catch (err) {
        left.push({ path: c.path, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    if (c.status !== 'A') restore.push(c.path);
  }
  for (let i = 0; i < restore.length; i += PATHSPEC_CHUNK) {
    const chunk = restore.slice(i, i + PATHSPEC_CHUNK);
    const res = await gitRun(
      dir,
      ['restore', `--source=${baseline.tree}`, '--worktree', '--', ...chunk],
      { GIT_LITERAL_PATHSPECS: '1' },
    );
    if (res.code !== 0) {
      for (const p of chunk) left.push({ path: p, reason: `not put back: ${gitDetail(res)}` });
    }
  }
  if (restore.length > 0) await gitRun(dir, ['update-index', '-q', '--refresh']);
  if (moved.length === 0 && left.length === 0) return null;
  const manifest = {
    dir: prefix.replace(/\/$/, '') || '.',
    baseline: baseline.tree,
    after,
    moved,
    left,
  };
  await writeFileNoFollow(
    anchor,
    `${folder}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { createParents: true, owner },
  ).catch(() => undefined);
  return { folder, moved, left };
}

/** One event per relocation, so every attempt's leftovers stay findable from the Activity tab. */
export async function recordFixerLeftovers(
  db: Database,
  taskId: string,
  taskStepId: string,
  branch: string,
  leftovers: FixerLeftovers,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType: 'merge.fixer_leftovers',
    payload: {
      branch,
      folder: leftovers.folder,
      moved: leftovers.moved.slice(0, 50),
      movedCount: leftovers.moved.length,
      left: leftovers.left.slice(0, 20),
      leftCount: leftovers.left.length,
      ...(leftovers.unchecked ? { unchecked: leftovers.unchecked } : {}),
    },
  });
}

/** The step's warning. It names the task's folder rather than one attempt's, since every attempt
 *  adds its own. */
export function fixerLeftoversWarning(taskId: string, leftovers: FixerLeftovers): string {
  if (leftovers.unchecked) {
    return `Could not check what a merge fixer changed outside the conflicted files: ${leftovers.unchecked}.`;
  }
  return `A merge fixer changed files outside the conflicted ones, and none of them was committed. They were moved to ${MERGE_LEFTOVERS_DIR}/${taskId}/, a folder per attempt whose manifest.json also lists any that could not be moved and are still in the tree.`;
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
    'Change no other file: only the conflicted files are committed, and anything else you change is',
    'moved out of the tree.',
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
  // Only the paths the fixer was sent to resolve: the merge staged everything else itself, and what
  // else the tree holds is someone's own work or a fixer's stray change, neither of it the merge's.
  for (let i = 0; i < files.length; i += PATHSPEC_CHUNK) {
    const add = await gitRun(
      worktreePath,
      ['add', '-A', '--', ...files.slice(i, i + PATHSPEC_CHUNK)],
      { GIT_LITERAL_PATHSPECS: '1' },
    );
    if (add.code !== 0) return false;
  }
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
