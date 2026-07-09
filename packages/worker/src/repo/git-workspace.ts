import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** `absent` — no `.git` entry: a legitimate in-place / no-git workspace.
 *  `broken` — a `.git` entry exists but git refuses it, e.g. a linked worktree whose
 *             gitfile points at a gitdir that does not resolve. Corruption.
 *  `ok`     — git accepts the directory as a work tree. */
export type GitWorkspaceStatus = 'absent' | 'broken' | 'ok';

async function probe(dir: string): Promise<{ status: GitWorkspaceStatus; detail: string }> {
  // Probe the entry before asking git anything. With `.git` absent, git's upward
  // discovery would report the PARENT repo for a nested directory — a worktree under
  // .haive/worktrees/ would silently operate on the parent checkout.
  try {
    await stat(path.join(dir, '.git'));
  } catch {
    return { status: 'absent', detail: '' };
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
