import { taskWriteTarget, setTaskSettlementTimeout } from '../task-fence.js';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { listResidentOllamaModels, unloadOllamaModel } from './embed.js';

/** The (ollamaUrl, embeddingModel) a task uses for RAG. */
export interface EmbedTarget {
  url: string;
  model: string;
}

/** The (ollamaUrl, embeddingModel) a task used for RAG — read from its
 *  04-tooling-infrastructure step output, falling back to the repo's latest
 *  onboarding run for workflow tasks (mirrors rag.ts resolveTaskRagContext).
 *  Returns null when no Ollama model was configured (hash-embedding fallback
 *  loads nothing, so there is nothing to unload). */
export async function resolveTaskEmbedTarget(
  db: Database | DbTx,
  taskId: string,
): Promise<EmbedTarget | null> {
  const readTooling = async (tid: string) => {
    const row = await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, tid),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
      ),
      columns: { output: true },
    });
    return (
      (row?.output as { tooling?: { ollamaUrl?: string; embeddingModel?: string } } | null) ?? null
    );
  };

  let tooling = await readTooling(taskId);
  if (!tooling?.tooling?.ollamaUrl || !tooling?.tooling?.embeddingModel) {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (task?.repositoryId) {
      const onboarding = await db.query.tasks.findFirst({
        where: and(
          eq(schema.tasks.repositoryId, task.repositoryId),
          eq(schema.tasks.type, 'onboarding'),
        ),
        orderBy: [desc(schema.tasks.createdAt)],
        columns: { id: true },
      });
      if (onboarding) tooling = await readTooling(onboarding.id);
    }
  }
  const url = tooling?.tooling?.ollamaUrl;
  const model = tooling?.tooling?.embeddingModel;
  return url && model ? { url, model } : null;
}

/** True when some live (non-terminal) task uses this
 *  exact (url, model) for RAG. A coarse "any live task" guard would wrongly pin a
 *  model whenever any unrelated task runs; this matches per (url, model) so two
 *  tasks on different RAG models can free either independently. */
export async function isEmbedModelUsedByLiveTask(
  db: Database | DbTx,
  url: string,
  model: string,
): Promise<boolean> {
  const liveTasks = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']));
  for (const lt of liveTasks) {
    const other = await resolveTaskEmbedTarget(db, lt.id);
    if (other && other.url === url && other.model === model) return true;
  }
  return false;
}

export type EmbedReleaseStatus = 'unloaded' | 'in_use' | 'not_resident' | 'unreachable';

/** Evict an embedding model from Ollama (keep_alive:0) ONLY when it is both
 *  resident and unused — the single safe-to-evict gate shared by task-cancel,
 *  worker-boot reconciliation and the API release endpoint. Order matters:
 *  residency is one cheap HTTP call and the common idle short-circuit, so it runs
 *  before the (multi-query) live-task scan. `alsoInUse` lets a caller fold in its
 *  own external usage signal (e.g. an in-flight global-KB sync job) without
 *  pulling its queue dependency into shared. `settlingTaskId` fences a task-triggered release
 *  against Retry. The live-task scan runs before taking that task row. */
export async function releaseEmbedModelIfUnused(
  db: Database | DbTx,
  opts: { url: string; model: string; alsoInUse?: boolean; settlingTaskId?: string },
): Promise<EmbedReleaseStatus> {
  const { url, model, alsoInUse, settlingTaskId } = opts;
  const resident = await listResidentOllamaModels(url);
  if (resident === null) return 'unreachable';
  if (!resident.includes(model)) return 'not_resident';
  if (alsoInUse) return 'in_use';
  if (await isEmbedModelUsedByLiveTask(db, url, model)) return 'in_use';
  const release = async (): Promise<EmbedReleaseStatus> => {
    const ok = await unloadOllamaModel(url, model);
    return ok ? 'unloaded' : 'unreachable';
  };
  if (!settlingTaskId) return release();
  // The settling task may have been revived after the job's first check. Its row
  // lock orders this unload against Retry's status/epoch write through the HTTP call.
  return db.transaction(async (tx) => {
    await setTaskSettlementTimeout(tx);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(taskWriteTarget(settlingTaskId, { settled: true }))
      .for('no key update');
    if (!task) return 'in_use';
    return release();
  });
}
