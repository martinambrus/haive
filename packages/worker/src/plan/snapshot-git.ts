import { HAIVE_DATA_FILES } from '@haive/shared';
import { gitRun } from '../repo/git-push.js';

export const PLAN_SNAPSHOT_GIT_PATHS = [
  HAIVE_DATA_FILES.plan,
  HAIVE_DATA_FILES.planMarkdown,
] as const;

/** Stage and commit only the portable plan projection. `git commit --only`
 *  deliberately leaves any work the user had already staged in the index. */
export async function commitPlanSnapshotFiles(args: {
  repoPath: string;
  message: string;
  identity: Record<string, string>;
}): Promise<{ committed: boolean; commitSha: string | null }> {
  const paths = [...PLAN_SNAPSHOT_GIT_PATHS];
  const add = await gitRun(args.repoPath, ['add', '-f', '-A', '--', ...paths]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);

  const diff = await gitRun(args.repoPath, ['diff', '--cached', '--quiet', '--', ...paths]);
  if (diff.code === 0) return { committed: false, commitSha: null };
  if (diff.code !== 1) throw new Error(`git diff failed: ${diff.stderr || diff.stdout}`);

  const commit = await gitRun(
    args.repoPath,
    ['commit', '--only', '-m', args.message, '--', ...paths],
    args.identity,
  );
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  const sha = await gitRun(args.repoPath, ['rev-parse', 'HEAD']);
  return { committed: true, commitSha: sha.code === 0 ? sha.stdout.trim() : null };
}
