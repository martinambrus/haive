import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isPathContainmentError, lstatNoFollow } from '@haive/shared/fs-safe';
import { workspaceAnchor } from './worktree-paths.js';

const exec = promisify(execFile);

/** `absent` — no `.git` entry: a legitimate in-place / no-git workspace.
 *  `broken` — a `.git` entry exists but is not usable, either because git refuses it (a linked
 *             worktree whose gitfile points at a gitdir that does not resolve) or because the path
 *             to it is one we will not follow (a link at `.git`, or in any component above it, which
 *             git never gets asked about). Corruption either way.
 *  `ok`     — git accepts the directory as a work tree. */
export type GitWorkspaceStatus = 'absent' | 'broken' | 'ok';

async function probe(dir: string): Promise<{ status: GitWorkspaceStatus; detail: string }> {
  // Probe the entry before asking git anything. With `.git` absent, git's upward
  // discovery would report the PARENT repo for a nested directory — a worktree under
  // .haive/worktrees/ would silently operate on the parent checkout.
  //
  // `dir` is a WORKTREE for most callers (00a, 10-gate-3-commit, 11a, 11b, 11d, 11-phase-8) and a
  // repository root for the rest, so it is SPLIT rather than used as the anchor: a worktree lives
  // under `.haive/`, which the sandbox mounts read-write.
  const { anchor, prefix } = workspaceAnchor(dir);
  let info: Awaited<ReturnType<typeof lstatNoFollow>>;
  try {
    info = await lstatNoFollow(anchor, `${prefix}.git`, { strict: true });
  } catch (err) {
    if (!isPathContainmentError(err)) throw err;
    // Strict, and refusals map to `broken` rather than `absent`, which is the load-bearing half:
    // `absent` makes a caller treat the tree as holding no repository and skip the commit — the
    // exact failure `requireUsableGit` exists to prevent. A component we will not follow is
    // corruption, not an empty tree.
    return { status: 'broken', detail: `the .git path is not usable (${err.reason})` };
  }
  if (info === null) return { status: 'absent', detail: '' };
  // A leaf link is REPORTED by lstat rather than refused, so it needs its own branch — and it is
  // the same verdict for the same reason.
  if (info.kind === 'symlink') {
    return { status: 'broken', detail: '.git is a symbolic link' };
  }
  try {
    const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (stdout.trim() === 'true') return { status: 'ok', detail: '' };
    return { status: 'broken', detail: stdout.trim() };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { status: 'broken', detail: (e.stderr ?? e.message ?? '').toString().trim() };
  }
}

/** Classify `dir`. Use this where a broken repo should degrade rather than fail —
 *  a viewer artifact, a runtime that must keep serving. Prefer {@link requireUsableGit}
 *  anywhere the step goes on to stage, commit or push. */
export async function gitWorkspaceStatus(dir: string): Promise<GitWorkspaceStatus> {
  return (await probe(dir)).status;
}

/** True when `dir` is a usable work tree, false when it holds no repo at all.
 *
 *  Throws when a `.git` entry exists but git refuses it. Steps used to collapse that
 *  case into "no git" (or into "0 dirty files"), which reads as an empty tree and
 *  silently skips the commit — that is how task 82949225 discarded its whole
 *  changeset after an agent poisoned the worktree gitfile. */
export async function requireUsableGit(dir: string): Promise<boolean> {
  const { status, detail } = await probe(dir);
  if (status === 'broken') {
    throw new Error(
      `${dir} has a .git entry but git cannot use it${detail ? `: ${detail}` : ''}. ` +
        'The repository or worktree gitfile is corrupt; refusing to treat it as an empty tree.',
    );
  }
  return status === 'ok';
}
