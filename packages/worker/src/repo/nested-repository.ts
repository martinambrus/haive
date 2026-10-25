import { lstatNoFollow, openDirNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from './git-exec.js';
import { workspaceAnchor } from './worktree-paths.js';

/** Read the nested checkout itself, never a HEAD discovered in its parent. A held
 * directory prevents a path swapped after the check from redirecting git. Exit 1
 * means no checked-out commit (the same ref read git add uses); failed reads throw. */
export async function nestedRepositoryHead(
  workspacePath: string,
  rel: string,
  run: typeof gitRun = gitRun,
): Promise<{ commit: string | null } | null> {
  const wa = workspaceAnchor(workspacePath);
  const dir = await openDirNoFollow(wa.anchor, `${wa.prefix}${rel}`);
  try {
    const cwd = `/proc/self/fd/${dir.fd}`;
    const marker = await lstatNoFollow(cwd, '.git', { strict: true });
    if (marker?.kind !== 'directory' && marker?.kind !== 'file') return null;
    const res = await run(cwd, ['--git-dir=.git', 'rev-parse', '--verify', '--quiet', 'HEAD']);
    if (res.code === 1) return { commit: null };
    const sha = res.stdout.trim();
    if (res.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
      throw new Error(
        `Nested repository HEAD could not be read at ${rel}: ${res.stderr || res.stdout}`,
      );
    }
    return { commit: sha };
  } finally {
    await dir.close();
  }
}
