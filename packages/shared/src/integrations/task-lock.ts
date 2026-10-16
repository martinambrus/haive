import { sql } from 'drizzle-orm';
import type { DbTx } from '@haive/database';

/** Held to the end of the transaction by a dispatch's stamp and by every change of a task's integration choice, so they never interleave. */
export async function lockTaskIntegrations(tx: DbTx, taskId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`task-integrations:${taskId}`}, 0))`,
  );
}
