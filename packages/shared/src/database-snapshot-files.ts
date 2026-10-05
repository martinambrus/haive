/** Outside all checkouts/worktrees and never mounted as a directory into a runtime or agent. */
export function databaseSnapshotRel(snapshot: {
  id: string;
  userId: string;
  repositoryId: string;
}): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (![snapshot.id, snapshot.userId, snapshot.repositoryId].every((id) => uuid.test(id))) {
    throw new Error('Invalid database snapshot storage identity');
  }
  return `_database_snapshots/${snapshot.userId}/${snapshot.repositoryId}/${snapshot.id}.sql.gz`;
}
