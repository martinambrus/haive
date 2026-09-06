import { logger } from '@haive/shared';
import { applyPlanPatch } from '@haive/shared/plan';

/** Creating a task from a node marks it taskable — a human picking a node to
 *  run is better evidence than any LLM guess. Best-effort: the flag is
 *  metadata, and a lost race for the version must not fail the task creation
 *  that triggered it.
 *
 *  ONE patch for the whole set rather than one call per node: `applyPlanPatch`
 *  opens a transaction and bumps the mirror revision per call, so N calls would
 *  cost N of each to record a flag. A node already taskable contributes no op,
 *  which is what makes a set of already-flagged nodes write nothing at all. */
export async function markPlanNodesTaskable(
  db: Parameters<typeof applyPlanPatch>[0],
  nodes: { id: string; taskable: boolean; version: number }[],
  repositoryId: string,
): Promise<boolean> {
  const pending = nodes.filter((n) => !n.taskable);
  if (pending.length === 0) return false;
  try {
    await applyPlanPatch(
      db,
      {
        ops: pending.map((n) => ({
          op: 'upsert' as const,
          nodeRef: n.id,
          expectedVersion: n.version,
          taskable: true,
        })),
      },
      { repositoryId, origin: 'user' },
    );
    return true;
  } catch (err) {
    // The whole patch is one transaction, so a stale version on any one node
    // drops the flag for all of them. That is the right trade for metadata: the
    // alternative is a per-node retry loop guarding a boolean.
    logger.warn(
      { err, nodeIds: pending.map((n) => n.id) },
      'taskable auto-mark on task create failed',
    );
    return false;
  }
}
