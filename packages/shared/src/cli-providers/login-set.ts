import { schema, type Database } from '@haive/database';
import { cliAuthSetWhere, type CliAuthProvider } from '../cli-auth-state.js';

/** Locks the rows that share a login, in id order. Call inside the transaction of a write that
 * spans the set, while holding the set's auth lock; provider rows are locked before any of
 * their secrets. */
export async function lockLoginSet(
  tx: Pick<Database, 'select'>,
  provider: CliAuthProvider,
): Promise<{ id: string; envVars: Record<string, string> | null }[]> {
  return tx
    .select({ id: schema.cliProviders.id, envVars: schema.cliProviders.envVars })
    .from(schema.cliProviders)
    .where(cliAuthSetWhere(provider))
    .orderBy(schema.cliProviders.id)
    .for('update');
}
