import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { markPlanMirrorDirty } from '@haive/shared/plan';
import { planMirrorPayloadSchema, planMirrorV2Schema } from '@haive/shared/schemas';
import {
  conflictBody,
  conflictSide,
  conflictSideValue,
  parsePlanConflictUnit,
  sameValue,
  type ProjectStateAnswer,
  type ProjectStateResolveResult,
} from '@haive/shared/project-state';
import type { PlanMirrorPayload } from '@haive/shared';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const nodeFieldSchemas = planMirrorV2Schema.shape.nodes.element.shape;

/** Sets one field of the stored base; a node the base does not hold stays out of it. */
async function setBaseField(
  tx: Tx,
  repositoryId: string,
  nodeId: string,
  field: string,
  value: unknown,
): Promise<void> {
  const [state] = await tx
    .select({ syncedSnapshot: schema.planMirrorState.syncedSnapshot })
    .from(schema.planMirrorState)
    .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    .limit(1);
  const base = planMirrorPayloadSchema.safeParse(state?.syncedSnapshot);
  if (!base.success || !base.data.nodes.some((n) => n.id === nodeId)) return;
  const snapshot = {
    ...base.data,
    nodes: base.data.nodes.map((n) => (n.id === nodeId ? { ...n, [field]: value } : n)),
  } as PlanMirrorPayload;
  await tx
    .update(schema.planMirrorState)
    .set({ syncedSnapshot: snapshot })
    .where(eq(schema.planMirrorState.repositoryId, repositoryId));
}

/** Answers one plan question under the plan-mirror lock the caller holds, taken before any
 *  repository or conflict row is locked: a reconcile holding it writes both. The flush then writes
 *  the answer into plan.json, and the next reconcile of that file finds the base and local agree. */
export async function answerPlanQuestion(
  tx: Tx,
  {
    repositoryId,
    userId,
    conflictId,
    answer,
  }: { repositoryId: string; userId: string; conflictId: string; answer: ProjectStateAnswer },
): Promise<ProjectStateResolveResult> {
  const [repo] = await tx
    .select({ userId: schema.repositories.userId })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId));
  if (!repo || repo.userId !== userId) return { kind: 'not_found' };
  const [row] = await tx
    .select()
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.id, conflictId),
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
      ),
    )
    .for('update');
  const parsed = row ? parsePlanConflictUnit(row.unit) : null;
  if (!row || !parsed) return { kind: 'not_found' };
  if (row.resolvedAt !== null) {
    return row.resolution === answer
      ? { kind: 'resolved', conflict: conflictBody(row), written: [] }
      : { kind: 'settled', resolution: row.resolution ?? '' };
  }

  const { nodeId, field } = parsed;
  const [node] = await tx
    .select()
    .from(schema.planNodes)
    .where(and(eq(schema.planNodes.id, nodeId), eq(schema.planNodes.repositoryId, repositoryId)))
    .for('update');
  const converged = async (): Promise<ProjectStateResolveResult> => {
    await tx
      .update(schema.projectStateConflicts)
      .set({ resolution: 'converged', resolvedAt: new Date() })
      .where(eq(schema.projectStateConflicts.id, row.id));
    return { kind: 'settled', resolution: 'converged' };
  };
  if (!node) return converged();

  const current = conflictSide((node as Record<string, unknown>)[field]);
  const incoming = conflictSideValue(row.incoming);
  if (sameValue(current, row.incoming)) {
    await setBaseField(tx, repositoryId, nodeId, field, incoming);
    return converged();
  }
  if (!sameValue(current, row.local)) {
    await tx
      .update(schema.projectStateConflicts)
      .set({ local: current })
      .where(eq(schema.projectStateConflicts.id, row.id));
    return { kind: 'moved' };
  }

  if (incoming === undefined) return { kind: 'invalid' };
  const now = new Date();
  if (answer === 'take_theirs') {
    const schemaOfField = (
      nodeFieldSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>
    )[field];
    if (schemaOfField?.safeParse(incoming).success !== true) return { kind: 'invalid' };
    const set: Record<string, unknown> = { [field]: incoming };
    if (field === 'status') {
      if (incoming === 'done') set.doneAt = now;
      else if (node.status === 'done') set.doneAt = null;
    }
    await tx
      .update(schema.planNodes)
      .set({ ...set, sourceTaskId: null, version: node.version + 1, updatedAt: now })
      .where(eq(schema.planNodes.id, nodeId));
  }
  await setBaseField(tx, repositoryId, nodeId, field, incoming);
  const [closed] = await tx
    .update(schema.projectStateConflicts)
    .set({ resolution: answer, resolvedAt: now, resolvedBy: userId })
    .where(eq(schema.projectStateConflicts.id, row.id))
    .returning();
  await markPlanMirrorDirty(tx, repositoryId);
  return {
    kind: 'resolved',
    conflict: conflictBody(closed ?? { ...row, resolution: answer, resolvedAt: now }),
    written: [],
  };
}
