import { eq, or } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { cliAuthSetWhere, type CliAuthProvider } from '../cli-auth-state.js';

/** Locks the rows that share a login, in id order. Call inside the transaction of a write that
 * spans the set, while holding the set's auth lock. It must be the first lock the transaction
 * takes on any provider row, before a provider row is updated or a secret of one is written: the
 * image job locks provider rows in id order without the auth lock, so a writer that holds one row
 * while it waits for a lower id can deadlock with it. `alsoId` is a row about to join the set. */
export async function lockLoginSet(
  tx: Pick<Database, 'select'>,
  provider: CliAuthProvider,
  alsoId?: string,
): Promise<{ id: string; envVars: Record<string, string> | null }[]> {
  return tx
    .select({ id: schema.cliProviders.id, envVars: schema.cliProviders.envVars })
    .from(schema.cliProviders)
    .where(
      alsoId === undefined
        ? cliAuthSetWhere(provider)
        : or(eq(schema.cliProviders.id, alsoId), cliAuthSetWhere(provider)),
    )
    .orderBy(schema.cliProviders.id)
    .for('update');
}
