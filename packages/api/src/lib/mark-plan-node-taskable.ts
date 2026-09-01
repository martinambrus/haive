import { logger } from '@haive/shared';
import { applyPlanPatch } from '@haive/shared/plan';

/** Creating a task from a node marks it taskable — a human picking a node to
 *  run is better evidence than any LLM guess. Best-effort: the flag is
 *  metadata, and a lost race for the version must not fail the task creation
 *  that triggered it. */
export async function markPlanNodeTaskable(
  db: Parameters<typeof applyPlanPatch>[0],
  node: { id: string; taskable: boolean; version: number },
  repositoryId: string,
): Promise<boolean> {
  if (node.taskable) return false;
  try {
    await applyPlanPatch(
      db,
      {
        ops: [
          {
            op: 'upsert',
            nodeRef: node.id,
            expectedVersion: node.version,
            taskable: true,
          },
        ],
      },
      { repositoryId, origin: 'user' },
    );
    return true;
  } catch (err) {
    logger.warn({ err, nodeId: node.id }, 'taskable auto-mark on task create failed');
    return false;
  }
}
