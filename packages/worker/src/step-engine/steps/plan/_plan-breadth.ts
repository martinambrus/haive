import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { stripNodeRefPrefix } from '@haive/shared/plan';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PatchBreadthViolation {
  parentRef: string;
  existingChildren: number;
  newChildren: number;
  totalChildren: number;
}

/**
 * Count NEW nodes by their direct parent before a plan patch reaches the
 * database. Existing-node updates carry UUID refs and do not consume another
 * child slot; temporary refs are creations. `self` is normalised to the real
 * focus id so its already-persisted children can be included in the limit.
 *
 * Refs go through the applier's own `stripNodeRefPrefix` first. This runs on the
 * raw reply, before the applier normalises it, so a `node:<uuid>` parent used to
 * key a bucket of its own with no existing children counted, and a `node:<uuid>`
 * update counted as a new child. MEASURED: 4 of 231 coverage replies parented
 * with the prefix.
 */
function newPatchChildrenByParent(ops: unknown[], selfNodeId: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const candidate = op as Record<string, unknown>;
    if (
      candidate.op !== 'upsert' ||
      typeof candidate.nodeRef !== 'string' ||
      typeof candidate.parentRef !== 'string'
    ) {
      continue;
    }
    const nodeRef = stripNodeRefPrefix(candidate.nodeRef);
    if (nodeRef === 'self' || UUID_RE.test(nodeRef)) continue;
    const bareParent = stripNodeRefPrefix(candidate.parentRef);
    const parentRef = bareParent === 'self' && selfNodeId ? selfNodeId : bareParent;
    counts.set(parentRef, (counts.get(parentRef) ?? 0) + 1);
  }
  return counts;
}

/** Pure boundary used by both the database-backed guard and regression tests. */
export function findPatchBreadthViolations(
  ops: unknown[],
  maxChildren: number,
  options: {
    selfNodeId?: string | null;
    existingChildren?: ReadonlyMap<string, number>;
  } = {},
): PatchBreadthViolation[] {
  const counts = newPatchChildrenByParent(ops, options.selfNodeId ?? null);
  const violations: PatchBreadthViolation[] = [];
  for (const [parentRef, newChildren] of counts) {
    const existingChildren = options.existingChildren?.get(parentRef) ?? 0;
    const totalChildren = existingChildren + newChildren;
    if (totalChildren > maxChildren) {
      violations.push({ parentRef, existingChildren, newChildren, totalChildren });
    }
  }
  return violations;
}

/**
 * Enforce the user's breadth choice transactionally for every plan-producing
 * agent. An over-wide reply is rejected before any operation lands. This is a
 * step-level invariant and therefore applies before any CLI/provider adapter.
 */
export async function assertPlanPatchWithinBreadth(
  db: Database,
  repositoryId: string,
  ops: unknown[],
  selfNodeId: string | null,
  maxChildren: number,
): Promise<void> {
  const patchCounts = newPatchChildrenByParent(ops, selfNodeId);
  const persistedParentIds = [...patchCounts.keys()].filter((ref) => UUID_RE.test(ref));
  const existingChildren = new Map<string, number>();
  if (persistedParentIds.length > 0) {
    const rows = await db
      .select({
        parentId: schema.planNodes.parentId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.planNodes)
      .where(
        and(
          eq(schema.planNodes.repositoryId, repositoryId),
          inArray(schema.planNodes.parentId, persistedParentIds),
        ),
      )
      .groupBy(schema.planNodes.parentId);
    for (const row of rows) {
      if (row.parentId) existingChildren.set(row.parentId, row.count);
    }
  }

  const violations = findPatchBreadthViolations(ops, maxChildren, {
    selfNodeId,
    existingChildren,
  });
  if (violations.length === 0) return;
  const details = violations
    .slice(0, 5)
    .map(
      (violation) =>
        `${violation.parentRef}: ${violation.existingChildren} existing + ${violation.newChildren} new = ${violation.totalChildren}`,
    )
    .join('; ');
  throw new Error(`breadth cap ${maxChildren} exceeded (${details})`);
}
