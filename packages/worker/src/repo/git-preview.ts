import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { removeNoFollow } from '@haive/shared/fs-safe';
import { parsePorcelainZ } from '../step-engine/steps/workflow/_commit-diff.js';
import { PROJECTION_TEMP_EXCLUDE } from './git-stage.js';
import { GIT_MAX_BUFFER, gitRun } from './git-exec.js';

/** Run-app edits never own the project record, plan, or internal writer files. */
export const RUN_APP_PATHSPECS = [
  '.',
  ':(top,exclude,glob).haive/**',
  ':(top,exclude).haive-data/state',
  ':(top,exclude).haive-data/plan.json',
  ':(top,exclude).haive-data/plan.md',
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
 *  including binary and oversized files whose preview contains metadata only. */
export async function gitPreview(cwd: string, paths?: readonly string[]): Promise<GitPreview> {
  const name = `run-app-preview-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  const run = async (args: string[], scratch = false) => {
    const result = await gitRun(
      cwd,
      ['-c', 'core.splitIndex=false', ...args],
      scratch ? env : undefined,
      { maxBuffer: GIT_MAX_BUFFER },
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
    await run(['read-tree', head], true);
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
    if (scope.length) await run(['add', '-A', '--', ...scope], true);
    const tree = await run(['write-tree'], true);
    // No rename pairing: both the added destination and deleted source belong to the scope.
    const listed = await gitRun(
      cwd,
      ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', head, tree],
      undefined,
      { maxBuffer: GIT_MAX_BUFFER },
    );
    if (listed.code !== 0)
      throw new Error(`git preview paths failed: ${listed.stderr || listed.stdout}`);
    return { head, ref, tree, paths: listed.stdout.split('\0').filter(Boolean) };
  } finally {
    await removeNoFollow(os.tmpdir(), name);
    await removeNoFollow(os.tmpdir(), `${name}.lock`);
  }
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
  if (merge.code !== 1)
    throw new Error('Finish or abort the open merge before committing session edits.');
  const made = await gitRun(
    cwd,
    ['commit-tree', preview.tree, '-p', preview.head, '-m', message],
    identity,
  );
  if (made.code !== 0) throw new Error(`git preview commit failed: ${made.stderr || made.stdout}`);
  const moved = await gitRun(cwd, ['update-ref', preview.ref, made.stdout.trim(), preview.head]);
  if (moved.code !== 0)
    throw new Error(
      'The branch changed since the commit preview. Reopen it and review the current edits before committing.',
    );
  const restore = await gitRun(cwd, [
    'restore',
    '--staged',
    `--source=${preview.tree}`,
    '--',
    ...preview.paths.map((p) => `:(top,literal)${p}`),
  ]);
  if (restore.code !== 0)
    throw new Error(
      `The reviewed commit landed, but its index could not be refreshed: ${restore.stderr || restore.stdout}`,
    );
  return true;
}
