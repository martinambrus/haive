import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  TASK_JOB_NAMES,
  type RepoRagCleanupPayload,
  type RepoResourceCleanupPayload,
  type TaskJobPayload,
} from '@haive/shared';
import type { getDb } from '../db.js';
import { getTaskQueue } from '../queues.js';

type Db = ReturnType<typeof getDb>;
/** Accepts either the top-level db handle or the `tx` param drizzle yields
 *  inside `db.transaction(async (tx) => ...)`. PgTransaction shares the
 *  insert/update surface with PostgresJsDatabase but isn't structurally
 *  assignable (`$client` is missing on tx), so we derive the union from
 *  the transaction callback's argument type. */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Clears the allowance-back watch columns (notify-only). Spread into any `tasks`
 *  update that moves a task OUT of the failed-armed state (retry/resume/retry_ai/skip/
 *  cancel), so a later usage-poll tick can't stamp a stale "allowance is back" signal and
 *  a re-failure re-arms cleanly. Kept here (the shared cancel helper) so all clear sites
 *  reference one definition. */
export const CLEAR_ALLOWANCE_WATCH = {
  awaitingAllowanceProviderId: null,
  allowanceResetAt: null,
  allowanceReplenishedAt: null,
};

/** Mark a single task row as cancelled and append the activity event.
 *  Caller is responsible for enqueueing the BullMQ CANCEL job (via
 *  enqueueCancelJob) AFTER any surrounding transaction commits — enqueueing
 *  inside a transaction would queue work for state that may roll back. */
export async function cancelTaskRow(
  tx: DbOrTx,
  taskId: string,
  opts: { by: string; reason?: string },
): Promise<void> {
  const now = new Date();
  await tx
    .update(schema.tasks)
    .set({ status: 'cancelled', completedAt: now, ...CLEAR_ALLOWANCE_WATCH, updatedAt: now })
    .where(eq(schema.tasks.id, taskId));
  // Transition any non-terminal step rows so a cancelled task never shows a live
  // step (e.g. a run_app hold step parked at waiting_form). step_status has no
  // 'cancelled' value, so mark them failed (mirrors the Stop path). The worker's
  // handleCancelTask repeats this idempotently; doing it here makes the UI
  // consistent immediately instead of after the CANCEL job runs.
  await tx
    .update(schema.taskSteps)
    .set({ status: 'failed', errorMessage: 'Task cancelled', endedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        inArray(schema.taskSteps.status, ['pending', 'running', 'waiting_form', 'waiting_cli']),
      ),
    );
  await tx.insert(schema.taskEvents).values({
    taskId,
    taskStepId: null,
    eventType: 'task.cancelled',
    payload: opts.reason ? { by: opts.by, reason: opts.reason } : { by: opts.by },
  });
}

/** Enqueue the worker-side cancel job that tears down sandboxes, terminal
 *  sessions, env images, and auth volumes for the cancelled task. Must be
 *  called AFTER the row update has committed. Idempotent on the worker side. */
export async function enqueueCancelJob(taskId: string, userId: string): Promise<void> {
  await getTaskQueue().add(TASK_JOB_NAMES.CANCEL, { taskId, userId } as TaskJobPayload, {
    removeOnComplete: 50,
    removeOnFail: 50,
  });
}

/** Find every non-terminal task pinned to the given repository for the given
 *  user and cancel each one (mark cancelled + append event). Used by the
 *  repo-delete handler so the schema's `set null` cascade does not orphan
 *  running tasks against a workdir that no longer exists. Returns the list
 *  of cancelled task ids so the caller can enqueue worker CANCEL jobs after
 *  the surrounding transaction commits. */
export async function cancelOpenTasksForRepo(
  tx: DbOrTx,
  repoId: string,
  userId: string,
): Promise<Array<{ id: string }>> {
  const open = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repoId),
        eq(schema.tasks.userId, userId),
        notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
      ),
    );
  for (const t of open) {
    await cancelTaskRow(tx, t.id, { by: userId, reason: 'repository_deleted' });
  }
  return open;
}

/** Collect the unique project names that the deleted repository's tasks
 *  populated with `ragMode='internal'`. The cleanup job uses these to decide
 *  which per-project RAG databases are eligible for `DROP DATABASE`. External
 *  and ddev tasks are filtered out — Haive does not own that infrastructure
 *  and must not touch it. Run BEFORE the repo row is deleted; the FK cascade
 *  sets `tasks.repository_id = NULL` and the link to the repo is lost. */
export async function collectInternalRagProjectNamesForRepo(
  tx: DbOrTx,
  repoId: string,
  userId: string,
): Promise<string[]> {
  const tasks = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.repositoryId, repoId), eq(schema.tasks.userId, userId)));
  if (tasks.length === 0) return [];

  const taskIds = tasks.map((t) => t.id);
  const out = new Set<string>();

  for (const taskId of taskIds) {
    const tooling = await tx
      .select({ output: schema.taskSteps.output })
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, taskId),
          eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
        ),
      )
      .limit(1);
    const toolingOutput = tooling[0]?.output as { tooling?: { ragMode?: string } } | null;
    if (toolingOutput?.tooling?.ragMode !== 'internal') continue;

    const env = await tx
      .select({ detectOutput: schema.taskSteps.detectOutput })
      .from(schema.taskSteps)
      .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-env-detect')))
      .limit(1);
    const envDetect = env[0]?.detectOutput as {
      data?: { project?: { name?: string } };
    } | null;
    const name = envDetect?.data?.project?.name;
    if (typeof name === 'string' && name.trim().length > 0) {
      out.add(name.trim());
    }
  }
  return Array.from(out);
}

/** Enqueue the worker-side job that drops per-project internal RAG databases
 *  belonging to a deleted repository. The worker re-checks for surviving
 *  consumers before each drop so a project name shared with another live
 *  repo does not lose its embeddings. Skipped if `projectNames` is empty. */
export async function enqueueRepoRagCleanupJob(payload: RepoRagCleanupPayload): Promise<void> {
  if (payload.projectNames.length === 0) return;
  await getTaskQueue().add(TASK_JOB_NAMES.CLEANUP_REPO_RAG, payload, {
    removeOnComplete: 50,
    removeOnFail: 50,
  });
}

/** Enqueue the worker-side job that tears down the Docker resources + on-disk
 *  workspace a deleted repository left behind (runners, unreferenced env images,
 *  haive_repos files). Ids/paths are captured before the delete. */
export async function enqueueRepoResourceCleanupJob(
  payload: RepoResourceCleanupPayload,
): Promise<void> {
  await getTaskQueue().add(TASK_JOB_NAMES.CLEANUP_REPO_RESOURCES, payload, {
    removeOnComplete: 50,
    removeOnFail: 50,
  });
}
