import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { PROJECT_STATE_DIR } from '@haive/shared/project-state';
import { removeNoFollow } from '@haive/shared/fs-safe';
import { parsePorcelainZ } from '../step-engine/steps/workflow/_commit-diff.js';
import { PROJECTION_TEMP_EXCLUDE } from './git-stage.js';
import { GIT_MAX_BUFFER, gitRun } from './git-exec.js';

/** Run-app edits never own the project record, plan, or internal writer files. */
export const RUN_APP_PATHSPECS = [
  '.',
  ':(top,exclude,glob).haive/**',
  ...[PROJECT_STATE_DIR, HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown].map(
    (rel) => `:(top,exclude)${rel}`,
  ),
  PROJECTION_TEMP_EXCLUDE,
];

export interface GitPreview {
  head: string;
  ref: string;
  tree: string;
  /** Literal paths, including both sides of a rename. */
  paths: string[];
}

/** Snapshot exactly what an add would commit, without changing the user's index.
 *  A supplied path set ignores later unrelated files. The tree pins bytes and modes,
 *  including binary and oversized files whose preview contains metadata only.
 *  A supplied base rechecks that same scope after its commit or a projection put-back. */
export async function gitPreview(
  cwd: string,
  paths?: readonly string[],
  baseHead?: string,
): Promise<GitPreview> {
  const name = `run-app-preview-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  const run = async (args: string[], scratch = false, input?: Buffer) => {
    const result = await gitRun(
      cwd,
      ['-c', 'core.splitIndex=false', ...args],
      scratch ? env : undefined,
      { maxBuffer: GIT_MAX_BUFFER, input },
    );
    if (result.code !== 0) throw new Error(`git preview failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  try {
    const head = await run(['rev-parse', 'HEAD']);
    const symbolic = await gitRun(cwd, ['symbolic-ref', '-q', 'HEAD']);
    if (symbolic.code !== 0 && symbolic.code !== 1)
      throw new Error('The checkout branch could not be read for the commit preview.');
    const ref = symbolic.code === 0 ? symbolic.stdout.trim() : 'HEAD';
    const base = baseHead ?? head;
    await run(['read-tree', base], true);
    let selected = paths;
    if (!selected) {
      const status = await gitRun(
        cwd,
        ['--no-optional-locks', 'status', '--porcelain', '-z', '-uall', '--', ...RUN_APP_PATHSPECS],
        undefined,
        { maxBuffer: GIT_MAX_BUFFER },
      );
      if (status.code !== 0)
        throw new Error(`git preview status failed: ${status.stderr || status.stdout}`);
      selected = [
        ...new Set(
          parsePorcelainZ(status.stdout).flatMap((entry) =>
            entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
          ),
        ),
      ];
    }
    const scope = selected.map((p) => `:(top,literal)${p}`);
    if (scope.length) {
      // Keep HEAD outside the scope, but start selected paths from the real index.
      // In particular, a staged removal must not make an ignored file tracked again.
      const listing = await run(['ls-files', '-s', '-z', '--', ...scope]);
      await run(
        ['update-index', '--force-remove', '-z', '--stdin'],
        true,
        Buffer.from(`${selected.join('\0')}\0`),
      );
      await run(['update-index', '--add', '-z', '--index-info'], true, Buffer.from(listing));
      const tagged = await run([
        'ls-files',
        '-v',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...scope,
      ]);
      const assumed: string[] = [];
      const skipped: string[] = [];
      const add: string[] = [];
      for (const record of tagged.split('\0')) {
        if (!record) continue;
        const tag = record.charAt(0);
        const name = record.slice(2);
        if (tag !== tag.toUpperCase()) assumed.push(name);
        if (tag.toUpperCase() === 'S') skipped.push(name);
        // Missing staged deletions and ignored, no-longer-tracked files are not
        // listed. Hidden index entries must retain their staged bytes as well.
        if (tag === tag.toUpperCase() && tag !== 'S') add.push(`:(top,literal)${name}`);
      }
      for (const [flag, names] of [
        ['--assume-unchanged', assumed],
        ['--skip-worktree', skipped],
      ] as const) {
        if (names.length)
          await run(
            ['update-index', '-z', flag, '--stdin'],
            true,
            Buffer.from(`${names.join('\0')}\0`),
          );
      }
      if (add.length) await run(['add', '-A', '--', ...add], true);
    }
    const tree = await run(['write-tree'], true);
    // No rename pairing: both the added destination and deleted source belong to the scope.
    const listed = await gitRun(
      cwd,
      ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', base, tree],
      undefined,
      { maxBuffer: GIT_MAX_BUFFER },
    );
    if (listed.code !== 0)
      throw new Error(`git preview paths failed: ${listed.stderr || listed.stdout}`);
    return { head, ref, tree, paths: listed.stdout.split('\0').filter(Boolean) };
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
    await removeNoFollow(os.tmpdir(), `${name}.lock`).catch(() => false);
  }
}

/** A landed preview has exactly its reviewed parent and tree, independent of its message. */
export async function gitPreviewWasCommitted(
  cwd: string,
  preview: GitPreview,
  commit: string,
): Promise<boolean> {
  if (!preview.paths.length) return false;
  const read = await gitRun(cwd, ['show', '-s', '--format=%P%n%T', commit]);
  if (read.code !== 0)
    throw new Error(`git preview commit read failed: ${read.stderr || read.stdout}`);
  const [parents, tree] = read.stdout.trim().split('\n');
  return parents === preview.head && tree === preview.tree;
}

const BRANCH_CHANGED =
  'The branch changed since the commit preview. Reopen it and review the current edits before committing.';

/** Every checkout write must still belong to the preview's named branch, including on Retry. */
export async function assertGitPreviewBranch(
  cwd: string,
  preview: GitPreview,
  committed = false,
): Promise<void> {
  const symbolic = await gitRun(cwd, ['symbolic-ref', '-q', 'HEAD']);
  const landed = committed ? `The reviewed commit landed on ${preview.ref}, but ` : '';
  if (symbolic.code !== 0 && symbolic.code !== 1)
    throw new Error(`${landed}the checkout branch could not be read for the commit preview.`);
  if (symbolic.code === 0 && symbolic.stdout.trim() === preview.ref) return;
  // A detached preview (ref 'HEAD') stays valid while HEAD is still detached; the ref CAS
  // on HEAD then catches a detached move to another commit.
  if (symbolic.code === 1 && preview.ref === 'HEAD') return;
  throw new Error(
    committed
      ? `${landed}the checked-out branch changed. Further index updates, projection put-back and push are stopped; return to that branch before retrying.`
      : BRANCH_CHANGED,
  );
}

// Commit the pinned tree and compare-and-swap its reviewed parent, so a terminal write stays
// uncommitted and a concurrent commit cannot be overwritten. Only the reviewed index paths move.
export async function commitGitPreview(
  cwd: string,
  preview: GitPreview,
  message: string,
  identity: Record<string, string>,
): Promise<boolean> {
  if (!preview.paths.length) return false;
  const merge = await gitRun(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (merge.code !== 0 && merge.code !== 1) {
    throw new Error(
      `git merge read failed: ${merge.stderr || merge.stdout || `exit ${merge.code}`}`,
    );
  }
  if (merge.code === 0)
    throw new Error('Finish or abort the open merge before committing session edits.');
  const made = await gitRun(
    cwd,
    ['commit-tree', preview.tree, '-p', preview.head, '-m', message],
    identity,
  );
  if (made.code !== 0) throw new Error(`git preview commit failed: ${made.stderr || made.stdout}`);
  // Git has no atomic HEAD + named-ref CAS. The parent CAS protects the previewed branch;
  // the second HEAD check below stops an intervening switch from resetting the new index.
  await assertGitPreviewBranch(cwd, preview);
  const moved = await gitRun(cwd, ['update-ref', preview.ref, made.stdout.trim(), preview.head]);
  if (moved.code !== 0) {
    // Verify a lost compare-and-swap through the ref, not git's translated error text.
    // A killed run or a lock/permission failure alone says nothing about the branch.
    if (moved.code > 0) {
      const actual = await gitRun(cwd, ['rev-parse', '--verify', preview.ref]);
      if (actual.code === 0 && actual.stdout.trim() !== preview.head) {
        throw new Error(BRANCH_CHANGED);
      }
    }
    throw new Error(
      `git update-ref failed: ${moved.stderr || moved.stdout || `exit ${moved.code}`}`,
    );
  }
  // Path reset also accepts a deleted source absent from both the tree and the index
  // (a staged rename). Restore rejects that source after the commit already landed.
  await assertGitPreviewBranch(cwd, preview, true);
  const restore = await gitRun(cwd, [
    'reset',
    '--quiet',
    preview.tree,
    '--',
    ...preview.paths.map((p) => `:(top,literal)${p}`),
  ]);
  if (restore.code !== 0)
    throw new Error(
      `The reviewed commit landed, but its index could not be refreshed: ${restore.stderr || restore.stdout}`,
    );
  return true;
}
