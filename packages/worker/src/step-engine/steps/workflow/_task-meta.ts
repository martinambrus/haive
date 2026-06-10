import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export interface TaskMeta {
  title: string;
  description: string;
}

export interface DdevWorkspace {
  /** Absolute worker path to the active workspace — the git worktree if one
   *  exists, else the repo root. */
  workspace: string;
  /** That same workspace expressed relative to the haive_repos volume root
   *  (mounted at /repos in the DDEV runner), e.g.
   *  `<userId>/<repoId>/.haive/worktrees/<branch>`. The runner's projectDir is
   *  `/repos/<repoSubpath>`. */
  repoSubpath: string;
}

/**
 * Resolve the workspace the per-task DDEV runner must operate on. All workflow
 * work runs in the git worktree (01-worktree-setup: ".haive/worktrees/<branch>"),
 * never the main checkout — so the `.ddev` an implementation writes AND the
 * migration code an imported old DB must be migrated against both live there, not
 * at the repo root. Returns the worktree path plus its volume-relative subpath (so
 * the runner mounts/`cd`s into the worktree), falling back to the repo root when
 * no worktree output exists. Returns null when the task has no repository.
 */
export async function resolveDdevWorkspace(
  db: Database,
  taskId: string,
  repoPath: string,
): Promise<DdevWorkspace | null> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { userId: true, repositoryId: true },
  });
  if (!task?.repositoryId) return null;

  const rows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-worktree-setup')),
    )
    .limit(1);
  const wt = rows[0]?.output as { worktreePath?: string } | null;
  const workspace = wt?.worktreePath ?? repoPath;

  // Worktree path relative to the repo root (e.g. ".haive/worktrees/<branch>", or
  // "" when there's no worktree). Appended to the known `<userId>/<repoId>` volume
  // subpath so the runner's /repos mount resolves the worktree.
  const rel = path.relative(repoPath, workspace);
  const repoSubpath =
    rel && !rel.startsWith('..')
      ? `${task.userId}/${task.repositoryId}/${rel}`
      : `${task.userId}/${task.repositoryId}`;

  return { workspace, repoSubpath };
}

export async function loadTaskMeta(db: Database, taskId: string): Promise<TaskMeta> {
  const row = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
  });
  return {
    title: row?.title ?? '',
    description: row?.description ?? '',
  };
}

export interface AppBootOutput {
  booted: boolean;
  skipped: boolean;
  bootCommand: string | null;
  appUrl: string | null;
  healthCheckPassed: boolean;
}

export async function loadAppBootOutput(
  db: Database,
  taskId: string,
): Promise<AppBootOutput | null> {
  const rows = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01a-app-boot')))
    .limit(1);
  const row = rows[0];
  if (!row?.output) return null;
  return row.output as AppBootOutput;
}
