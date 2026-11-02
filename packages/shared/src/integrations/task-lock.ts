import { sql } from 'drizzle-orm';
import type { DbTx } from '@haive/database';

/** Held to the end of the transaction by a dispatch's stamp and by every change of a task's integration choice, so they never interleave. */
export async function lockTaskIntegrations(tx: DbTx, taskId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`task-integrations:${taskId}`}, 0))`,
  );
}

/** A revive can already hold step rows; never wait behind a dispatch that needs those rows. */
export async function tryLockTaskIntegrations(tx: DbTx, taskId: string): Promise<boolean> {
  const rows = await tx.execute(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${`task-integrations:${taskId}`}, 0)) as locked`,
  );
  return rows[0]?.locked === true;
}
