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

/** Task types that may run with no repository.
 *
 *  An allowlist and not a blanket "null is fine", because a null `repositoryId` has TWO
 *  meanings: a task deliberately created without one, and a task whose repository was deleted
 *  out from under it (`tasks.repository_id` is `ON DELETE SET NULL`). The second is a torn
 *  state and should still fail loudly — a workflow run whose repo vanished cannot do anything
 *  useful, and silently handing it an empty directory would turn that into a confusing agent
 *  failure several minutes later. */
const REPO_OPTIONAL_TASK_TYPES: ReadonlySet<string> = new Set(['kb_author']);

export function taskTypeAllowsNoRepository(type: string): boolean {
  return REPO_OPTIONAL_TASK_TYPES.has(type);
}

/** Whether this task was CREATED without a repository, as opposed to having LOST one.
 *
 *  `taskTypeAllowsNoRepository` cannot answer that. It keys on the TYPE, and for `kb_author`
 *  the two meanings of a null `repository_id` wear the same type — so the allowlist alone
 *  re-admits exactly the torn state it was written to keep out. Deleting a repository sets the
 *  FK to NULL (`ON DELETE SET NULL`) and `cancelOpenTasksForRepo` skips terminal tasks, so a
 *  FAILED anchored task keeps its status and, on retry, reads as repo-less: it would be handed
 *  an empty workspace and told no repository was selected, and could then publish a DIFFERENT,
 *  generic article over the entry the author anchored on purpose.
 *
 *  An ABSENT record reads as ANCHORED, which is the opposite of the usual presence-bit default
 *  and is not a judgement call: `enrichSchema.repositoryId` was a REQUIRED uuid until this branch
 *  made it optional, so a `kb_author` task created before the record necessarily HAD a repository.
 *  Absent therefore means "anchored", never "unknown", and treating it as permissive would admit
 *  exactly the tasks the old schema proves were anchored. (`cli_choice_recorded`'s lenient default
 *  is the right shape only where the legacy state is genuinely ambiguous; here it is not.)
 *
 *  `backfillKbAuthorAnchors` stamps the record on the tasks that predate it, so the strict default
 *  applies only to a task no evidence could classify. */
export function taskWasCreatedRepoLess(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  if (!('anchorRepositoryId' in metadata)) return false;
  return (metadata as { anchorRepositoryId?: unknown }).anchorRepositoryId == null;
}

/** Whether THIS task may run without a repository: the type allows it AND it was not anchored to
 *  a repository that has since been deleted.
 *
 *  One rule, because the decision has THREE call sites and they are reached by different routes —
 *  `resolveTaskContext` when the task runs, and both mount resolvers, one of which the human
 *  Terminal calls directly without ever going through the task context. Splitting the two halves
 *  across those sites is how the deleted-anchor case came back after being closed in one of them.
 *
 *  `resolveTaskContext` deliberately does NOT use this: it distinguishes the two refusals in its
 *  error message, and "this type never runs repo-less" and "your anchor was deleted" are different
 *  things to tell someone. Here both mean the same thing — no scratch mount. */
export function taskMayRunWithoutRepository(task: { type: string; metadata: unknown }): boolean {
  return taskTypeAllowsNoRepository(task.type) && taskWasCreatedRepoLess(task.metadata);
}
