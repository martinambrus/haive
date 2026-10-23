import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { RTK_ENABLED_UNIT, isRtkQuestion } from '../project-state/conflicts.js';

/** The columns that switch a repository's RTK on or off, which the tooling page's PATCH and the answer
 *  to an imported RTK-off question both write; each also stamps `rtkChoiceMadeAt` on a change. */
export const rtkEnabledUpdate = (enabled: boolean): { rtkEnabled: boolean; updatedAt: Date } => ({
  rtkEnabled: enabled,
  updatedAt: new Date(),
});

/** Closes a pending RTK question as converged: RTK is off here, so the other install's value already
 *  stands. Every writer of `rtk_enabled = false` calls it in the transaction that writes the column. */
export async function convergeRtkQuestion(
  db: Database | DbTx,
  repositoryId: string,
  userId: string | null,
): Promise<void> {
  const open = await db
    .select({
      id: schema.projectStateConflicts.id,
      unit: schema.projectStateConflicts.unit,
      base: schema.projectStateConflicts.base,
      local: schema.projectStateConflicts.local,
    })
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        eq(schema.projectStateConflicts.unit, RTK_ENABLED_UNIT),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    );
  const ids = open.filter(isRtkQuestion).map((row) => row.id);
  if (ids.length === 0) return;
  await db
    .update(schema.projectStateConflicts)
    .set({ resolution: 'converged', resolvedAt: new Date(), resolvedBy: userId })
    .where(
      and(
        inArray(schema.projectStateConflicts.id, ids),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    );
}
