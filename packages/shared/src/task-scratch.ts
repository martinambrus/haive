/** Where a repo-less task's scratch workspace lives, RELATIVE to the repo storage root.
 *
 *  Shared because TWO packages have to agree on this name and neither may import the other: the
 *  worker creates the directory and mounts it into the sandbox, and the api roots the Editor at
 *  it. It lived in the worker alone, so `resolveWorkspaceRoot` had no way to name the workspace
 *  and answered 409 for the one task type whose Editor is deliberately enabled without a
 *  worktree — an advertised recovery surface that could not open.
 *
 *  Only the NAME is shared. Who is entitled to a workspace stays entirely in the worker, which is
 *  the only creator: the api treats the directory's EXISTENCE as the entitlement rather than
 *  re-deriving the rule, so the two cannot drift apart as that rule changes. */
export const TASK_SCRATCH_DIR = '_scratch';

/** Volume-relative path, the shape `resolveInvocationRepoMount` already uses for a repository
 *  (`<userId>/<repositoryId>`). Cannot collide with a sibling: every other entry under a user's
 *  directory is a repository UUID. */
export function taskScratchSubpath(userId: string, taskId: string): string {
  return `${userId}/${TASK_SCRATCH_DIR}/${taskId}`;
}
