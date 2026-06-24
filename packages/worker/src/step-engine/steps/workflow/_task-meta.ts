import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export interface TaskMeta {
  title: string;
  description: string;
  /** Optional feature/area the task targets (tasks.metadata.feature). Null when
   *  not set. Used to bias discovery search and baked into bug investigations. */
  feature: string | null;
  /** Clients/tenants the fix affects (tasks.metadata.affectedClients). Empty when
   *  not set. Recorded only in the local investigation frontmatter. */
  affectedClients: string[];
  /** Task category at creation (tasks.metadata.category), e.g. 'bugfix'. Null when
   *  unset. Combined with the title/description by isBugBranch to classify the task. */
  category: string | null;
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
  const meta = (row?.metadata ?? null) as {
    feature?: unknown;
    affectedClients?: unknown;
    category?: unknown;
  } | null;
  const feature =
    typeof meta?.feature === 'string' && meta.feature.length > 0 ? meta.feature : null;
  const affectedClients = Array.isArray(meta?.affectedClients)
    ? meta.affectedClients.filter((c): c is string => typeof c === 'string')
    : [];
  const category =
    typeof meta?.category === 'string' && meta.category.length > 0 ? meta.category : null;
  return {
    title: row?.title ?? '',
    description: row?.description ?? '',
    feature,
    affectedClients,
    category,
  };
}

export interface AppBootOutput {
  booted: boolean;
  skipped: boolean;
  bootCommand: string | null;
  appUrl: string | null;
  healthCheckPassed: boolean;
  /** True when the app was launched inside its per-task app-runner container
   *  (the non-DDEV single-process path) rather than on the worker host. */
  containerized?: boolean;
  /** The app-runner container name when containerized (else null). The Phase 3
   *  runtime resolver + the VNC bridge dial this. */
  runtimeContainer?: string | null;
  /** Port the app listens on inside the runtime container (containerized). */
  port?: number | null;
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
