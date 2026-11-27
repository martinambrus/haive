import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/** A queue invocation owns preparation only while its admission token is still pending.
 * The scope is installed at pickup, never inferred from an ownerless repository/payload. */
const owners = new AsyncLocalStorage<{ repositoryId: string; jobId: string }>();

export class ObsoleteRepoJobError extends Error {
  constructor() {
    super('Repository preparation is no longer owned by this job');
  }
}

export function withRepoJobOwner<T>(repositoryId: string, jobId: string, run: () => Promise<T>) {
  return owners.run({ repositoryId, jobId }, run);
}

export function repoJobPredicate(repositoryId: string) {
  const owner = owners.getStore();
  if (!owner?.jobId || owner.repositoryId !== repositoryId) throw new ObsoleteRepoJobError();
  return and(
    eq(schema.repositories.id, repositoryId),
    eq(schema.repositories.refreshJobId, owner.jobId),
    eq(schema.repositories.refreshPending, true),
  )!;
}

export async function assertRepoJobOwner(db: Database, repositoryId: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.repositories.id })
    .from(schema.repositories)
    .where(repoJobPredicate(repositoryId))
    .limit(1);
  if (!row) throw new ObsoleteRepoJobError();
}
