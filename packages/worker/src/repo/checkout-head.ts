import { lstatNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from './git-exec.js';
import { gitWorkspaceStatus } from './git-workspace.js';

export interface NamedCheckout {
  ref: string;
  sha: string;
}

/** Observe the actual checkout, never repositories.branch. A detached, unborn or unreadable HEAD
 * cannot admit a background import. Check both ends so a checkout moving during the reads holds. */
export async function readNamedCheckout(repoPath: string): Promise<NamedCheckout | null> {
  if ((await gitWorkspaceStatus(repoPath)) !== 'ok') return null;
  const ref = await gitRun(repoPath, ['symbolic-ref', '-q', 'HEAD']);
  const name = ref.stdout.trim();
  if (ref.code !== 0 || !name.startsWith('refs/heads/')) return null;
  const head = await gitRun(repoPath, ['rev-parse', '--verify', 'HEAD']);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const branch = await gitRun(repoPath, ['rev-parse', '--verify', name]);
  const after = await gitRun(repoPath, ['symbolic-ref', '-q', 'HEAD']);
  return branch.code === 0 &&
    branch.stdout.trim() === sha &&
    after.code === 0 &&
    after.stdout.trim() === name
    ? { ref: name, sha }
    : null;
}

export async function checkoutMatches(repoPath: string, expected: NamedCheckout): Promise<boolean> {
  const now = await readNamedCheckout(repoPath);
  return now?.ref === expected.ref && now.sha === expected.sha;
}

/** Whether the checkout directory is gone: absent, or not a directory. Strict on purpose: an
 * unreadable parent (EACCES) is not a gone checkout and must keep failing loudly, where a lenient
 * read would answer `null` and read as one. */
export async function checkoutMissing(repoPath: string): Promise<boolean> {
  return (await lstatNoFollow(repoPath, '', { strict: true })) === null;
}
