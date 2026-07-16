import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { WORKTREE_SUBDIR } from './worktree-paths.js';

export const HOST_REPO_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';

export const WORKTREE_GIT_BOUNDARY_MARKER = '<haive_worktree_git_boundary>';

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
