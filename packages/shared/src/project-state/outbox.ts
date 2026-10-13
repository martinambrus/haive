import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** Marks the repository's project state record stale. Call it in the transaction of the mutation. */
export async function markProjectStateDirty(tx: DbOrTx, repositoryId: string): Promise<void> {
  await tx
    .insert(schema.projectStateOutbox)
    .values({ repositoryId, revision: 1, writtenRevision: 0, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.projectStateOutbox.repositoryId,
      set: {
        revision: sql`${schema.projectStateOutbox.revision} + 1`,
        lastError: null,
        updatedAt: new Date(),
      },
    });
}
