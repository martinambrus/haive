import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database, type DbTx } from '@haive/database';
import { RTK_ENABLED_UNIT } from '../project-state/conflicts.js';

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
  await db
    .update(schema.projectStateConflicts)
    .set({ resolution: 'converged', resolvedAt: new Date(), resolvedBy: userId })
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        eq(schema.projectStateConflicts.unit, RTK_ENABLED_UNIT),
        isNull(schema.projectStateConflicts.resolvedAt),
        sql`${schema.projectStateConflicts.base} IS NOT DISTINCT FROM ${schema.projectStateConflicts.local}`,
      ),
    );
}
