import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { worktreeDirName, WORKTREE_SUBDIR } from './worktree-paths.js';

export const HOST_REPO_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';

export const WORKTREE_GIT_BOUNDARY_MARKER = '<haive_worktree_git_boundary>';

/** Whether the task has a repository at all.
 *
 *  Lives beside the worktree boundary because it answers the same KIND of question for the
 *  dispatcher — what the sandbox will actually contain — and the dispatcher deliberately holds
 *  no drizzle imports of its own. Distinct from "is there a mount": a task type allowed to run
 *  repo-less is given an empty scratch workspace, so it is mounted and has no repository. */
export async function taskHasRepository(db: Database, taskId: string): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  return task?.repositoryId != null;
}

/** Prompt contract paired with the read-only empty-file mask over a linked
 * worktree's `.git` gitfile. It explains the boundary before a model can mistake
 * the intentional sentinel for repository corruption and try to repair it. */
export const WORKTREE_GIT_BOUNDARY_PROMPT = [
  WORKTREE_GIT_BOUNDARY_MARKER,
  'Git/worktree separation boundary:',
  'The `.git` entry at the workspace root is intentionally presented as a zero-byte, read-only file.',
  'This is a Haive containment boundary, not repository corruption or a workspace permission problem.',
  'Do not inspect, edit, delete, replace, chmod, chown, repair, or work around `.git`, and do not run git commands.',
  'Edit only the normal working-tree files needed for this task. Haive keeps the real git metadata outside the sandbox and will stage, commit, and merge your changes host-side.',
  '</haive_worktree_git_boundary>',
].join('\n');

/** Prepend the contract once. The marker makes this safe when nested prompt
 * builders or retry paths apply the same boundary more than once. */
export function withWorktreeGitBoundary(prompt: string, enabled: boolean): string {
  if (!enabled || prompt.includes(WORKTREE_GIT_BOUNDARY_MARKER)) return prompt;
  return `${WORKTREE_GIT_BOUNDARY_PROMPT}\n\n${prompt}`;
}

interface InvocationRepoTarget {
  storagePath?: string | null;
  localPath?: string | null;
  worktreeBranch?: string | null;
  /** Same semantics as CliExecJobPayload.worktreeRel. */
  worktreeRel?: string;
}

/** The single predicate shared by prompt construction and mount resolution.
 * True means the invocation receives a linked worktree at the mount root and
 * therefore also receives the zero-byte `.git` mask. */
export function invocationUsesWorktreeGitBoundary(target: InvocationRepoTarget): boolean {
  const storagePath = target.storagePath ?? target.localPath;
  // Host-path repositories are mounted read-only at their repository root; no
  // linked worktree or gitfile mask is exposed to the CLI.
  if (storagePath?.startsWith(`${HOST_REPO_ROOT}/`)) return false;

  if (target.worktreeRel !== undefined) {
    return target.worktreeRel.includes(`${WORKTREE_SUBDIR}/`);
  }
  return Boolean(target.worktreeBranch);
}

/** Resolve the boundary before an adapter serializes its prompt into CLI args.
 * `worktreeRel` must be the same override later placed on CliExecJobPayload. */
export async function resolveInvocationUsesWorktreeGitBoundary(
  db: Database,
  taskId: string,
  worktreeRel?: string,
): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true, worktreeBranch: true },
  });
  if (!task?.repositoryId) return false;

  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  if (!repo) return false;

  return invocationUsesWorktreeGitBoundary({
    storagePath: repo.storagePath,
    localPath: repo.localPath,
    worktreeBranch: task.worktreeBranch,
    worktreeRel,
  });
}

export const WORKER_REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';

/** The repo-volume subpath ONE invocation mounts, or `undefined` for a read-only local-path
 *  repository, which is bound at its root and has no subpath at all.
 *
 *  `worktreeRel` is repo-root-relative: `''` means the repo root, a worktree rel means that
 *  worktree. Unset falls back to the feature worktree derived from `worktreeBranch`, and a task
 *  with no branch (onboarding) gets the bare repo-root subpath.
 *
 *  Lives here rather than in cli-exec's resolvers because the dispatcher needs the same answer
 *  and cannot import that file: `resolvers.ts` reaches the dispatcher back through
 *  `task-queue.ts` -> `step-engine/index.ts` -> `step-runner.ts`. `resolvers.ts` re-exports it,
 *  so the secret and `#ddev-generated` masks keep their existing imports. */
export function invocationRepoSubpath(args: {
  storagePath: string | null;
  localPath?: string | null;
  userId: string;
  repositoryId: string;
  worktreeBranch?: string | null;
  worktreeRel?: string;
}): string | undefined {
  const storagePath = args.storagePath ?? args.localPath ?? null;
  if (storagePath && storagePath.startsWith(`${HOST_REPO_ROOT}/`)) return undefined;

  const base = `${args.userId}/${args.repositoryId}`;
  if (args.worktreeRel != null) {
    return args.worktreeRel ? `${base}/${args.worktreeRel}` : base;
  }
  if (args.worktreeBranch) {
    return `${base}/${WORKTREE_SUBDIR}/${worktreeDirName(args.worktreeBranch)}`;
  }
  return base;
}

/** The worker-side path of the tree ONE invocation will mount, resolved from the task.
 *
 *  `ctx.repoPath` is always the repository ROOT, while cli-exec mounts the invocation's worktree,
 *  so a dispatch-side reader that wants the bytes the agent will see has to resolve the same tree
 *  the mount will bind. Composes the two functions beside it rather than re-deriving either.
 *
 *  Null when the task has no repository (nothing is mounted) or its repository row is gone. For a
 *  read-only local-path repository `invocationRepoSubpath` declines and the answer is the
 *  `/host-fs` view of the repo root — which is exactly what that mount binds.
 *
 *  Async and DB-backed, so it is called only where a verdict needs the real tree: the
 *  project-instruction scan and the persona reader. */
export async function resolveInvocationWorkerTree(
  db: Database,
  taskId: string,
  worktreeRel?: string,
): Promise<string | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, repositoryId: true, worktreeBranch: true },
  });
  if (!task?.repositoryId) return null;

  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  if (!repo) return null;

  const storagePath = repo.storagePath ?? repo.localPath;
  const subpath = invocationRepoSubpath({
    storagePath,
    userId: task.userId,
    repositoryId: task.repositoryId,
    worktreeBranch: task.worktreeBranch,
    worktreeRel,
  });
  return resolveInvocationWorkerRoot({
    repoMountSubpath: subpath,
    storagePath,
    userId: task.userId,
    repositoryId: task.repositoryId,
  });
}

/** The worker's own filesystem path for the tree an invocation actually mounts.
 *
 *  Mirrors resolveTaskRepoMount: a volume mount carries a subpath (the worktree this invocation
 *  is isolated to, or the repo root for a task with no worktree), while a bind mount (read-only
 *  local-path repo) has no subpath and is the worker's /host-fs view of the repo root. With no
 *  mount supplied (unit tests / defensive) it falls back to the repo-root tree the mount would
 *  bind.
 *
 *  Pure, and shared by every mask that scans what the sandbox will see, so the scanned set can
 *  never drift from the mounted set — the failure mode this exists to prevent is a mask computed
 *  against a path the container never binds, which silently masks nothing while looking like a
 *  clean repo. */
export function resolveInvocationWorkerRoot(args: {
  repoMountSubpath?: string;
  storagePath: string | null;
  userId: string;
  repositoryId: string;
}): string {
  if (args.repoMountSubpath) {
    return posix.join(WORKER_REPO_STORAGE_ROOT, args.repoMountSubpath);
  }
  if (args.storagePath?.startsWith(HOST_REPO_ROOT + '/')) return args.storagePath;
  return posix.join(WORKER_REPO_STORAGE_ROOT, `${args.userId}/${args.repositoryId}`);
}
