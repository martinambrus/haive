import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/** A queue invocation owns preparation only while its admission token is still pending.
 * The scope is installed at pickup, never inferred from an ownerless repository/payload. */
const owners = new AsyncLocalStorage<{ repositoryId: string; jobId: string }>();

export type RepoJobRefusalReason =
  'no_owner_on_row' | 'different_owner' | 'not_pending' | 'invalid_scope' | 'ownership_changed';

export class ObsoleteRepoJobError extends Error {
  constructor(readonly reason: RepoJobRefusalReason = 'ownership_changed') {
    super('Repository preparation is no longer owned by this job');
  }
}

export function withRepoJobOwner<T>(repositoryId: string, jobId: string, run: () => Promise<T>) {
  return owners.run({ repositoryId, jobId }, run);
}

export function repoJobPredicate(repositoryId: string) {
  const owner = owners.getStore();
  if (!owner?.jobId || owner.repositoryId !== repositoryId)
    throw new ObsoleteRepoJobError('invalid_scope');
  return and(
    eq(schema.repositories.id, repositoryId),
    eq(schema.repositories.refreshJobId, owner.jobId),
    eq(schema.repositories.refreshPending, true),
  )!;
}

export async function assertRepoJobOwner(db: Database, repositoryId: string) {
  const [row] = await db
    .select({
      id: schema.repositories.id,
      status: schema.repositories.status,
      storagePath: schema.repositories.storagePath,
    })
    .from(schema.repositories)
    .where(repoJobPredicate(repositoryId))
    .limit(1);
  if (row) return row;

  // Diagnose a refusal only after the admission predicate has rejected it. This
  // read cannot authorize work, even if ownership changes again before it returns.
  const [current] = await db
    .select({
      refreshJobId: schema.repositories.refreshJobId,
      refreshPending: schema.repositories.refreshPending,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const reason: RepoJobRefusalReason = !current?.refreshJobId
    ? 'no_owner_on_row'
    : current.refreshJobId !== owners.getStore()!.jobId
      ? 'different_owner'
      : !current.refreshPending
        ? 'not_pending'
        : 'ownership_changed';
  throw new ObsoleteRepoJobError(reason);
}
