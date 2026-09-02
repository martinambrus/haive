import { and, eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when an expansion reply explicitly chose one of the two valid exits. */
export function hasSemanticExpansionResolution(ops: unknown[], selfNodeId: string): boolean {
  return ops.some((op) => {
    if (!op || typeof op !== 'object') return false;
    const candidate = op as Record<string, unknown>;
    if (candidate.op !== 'upsert') return false;
    const marksSelfTaskable =
      (candidate.nodeRef === selfNodeId || candidate.nodeRef === 'self') &&
      candidate.taskable === true;
    const createsDirectChild =
      typeof candidate.nodeRef === 'string' &&
      candidate.nodeRef !== 'self' &&
      !UUID_RE.test(candidate.nodeRef) &&
      (candidate.parentRef === 'self' || candidate.parentRef === selfNodeId);
    return marksSelfTaskable || createsDirectChild;
  });
}

/**
 * Make legacy/underspecified atomic replies explicit. Historically [] meant
 * "cannot decompose" and a link/body-only reply had the same practical shape,
 * but both left a non-taskable leaf that looked unfinished forever. Preserve
 * the agent's semantic stop by recording taskable=true on its focus node.
 */
export async function ensureSemanticExpansionResolution(
  db: Database,
  repositoryId: string,
  selfNodeId: string | null,
  ops: unknown[],
): Promise<unknown[]> {
  if (!selfNodeId || hasSemanticExpansionResolution(ops, selfNodeId)) return ops;

  const existingUpdate = ops.findIndex((op) => {
    if (!op || typeof op !== 'object') return false;
    const candidate = op as Record<string, unknown>;
    return (
      candidate.op === 'upsert' &&
      (candidate.nodeRef === selfNodeId || candidate.nodeRef === 'self')
    );
  });
  if (existingUpdate >= 0) {
    return ops.map((op, index) =>
      index === existingUpdate ? { ...(op as Record<string, unknown>), taskable: true } : op,
    );
  }

  const [focus] = await db
    .select({ version: schema.planNodes.version })
    .from(schema.planNodes)
    .where(
      and(eq(schema.planNodes.repositoryId, repositoryId), eq(schema.planNodes.id, selfNodeId)),
    )
    .limit(1);
  if (!focus) throw new Error(`atomic expansion target ${selfNodeId} no longer exists`);
  return [
    ...ops,
    {
      op: 'upsert',
      nodeRef: selfNodeId,
      expectedVersion: focus.version,
      taskable: true,
    },
  ];
}
