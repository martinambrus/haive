import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database, type DbTx } from './index.js';

/** Short metadata sections only. Exports/imports/file removal never hold a pool connection. */
export async function withDatabaseSnapshotLock<T>(
  db: Database | DbTx,
  repositoryId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return (db as Database).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '30s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`database-snapshots:${repositoryId}`}, 0))`,
    );
    return fn(tx);
  });
}

export class DatabaseSnapshotUnavailableError extends Error {}

/** Pin the exact UI choice while serialised with promotion and GC, before enqueueing START. */
export async function initializeTaskDatabaseState(
  db: Database | DbTx,
  task: { id: string; repositoryId: string | null; userId: string },
  options: { sourceSnapshotId?: string; saveEnabled?: boolean } = {},
) {
  if (!task.repositoryId) return null;
  return withDatabaseSnapshotLock(db, task.repositoryId, async (tx) => {
    const existing = await tx.query.taskDatabaseStates.findFirst({
      where: eq(schema.taskDatabaseStates.taskId, task.id),
    });
    if (existing) return existing;
    let head = await tx.query.repositoryDatabaseStates.findFirst({
      where: eq(schema.repositoryDatabaseStates.repositoryId, task.repositoryId!),
    });
    if (!head) {
      [head] = await tx
        .insert(schema.repositoryDatabaseStates)
        .values({ repositoryId: task.repositoryId! })
        .returning();
    }
    if (options.sourceSnapshotId) {
      const snapshot = await tx.query.databaseSnapshots.findFirst({
        where: and(
          eq(schema.databaseSnapshots.id, options.sourceSnapshotId),
          eq(schema.databaseSnapshots.repositoryId, task.repositoryId!),
          eq(schema.databaseSnapshots.userId, task.userId),
          eq(schema.databaseSnapshots.status, 'ready'),
        ),
      });
      if (!snapshot || head?.snapshotId !== options.sourceSnapshotId)
        throw new DatabaseSnapshotUnavailableError(
          'The saved database selection changed. Refresh and select the current database.',
        );
    }
    const [state] = await tx
      .insert(schema.taskDatabaseStates)
      .values({
        taskId: task.id,
        repositoryId: task.repositoryId!,
        baseRevision: head!.revision,
        sourceSnapshotId: options.sourceSnapshotId ?? null,
        saveEnabled: options.saveEnabled ?? true,
      })
      .returning();
    return state!;
  });
}

export function snapshotPromotionAllowed(
  baseRevision: number,
  currentRevision: number,
  approvedRevision?: number,
): boolean {
  return currentRevision === (approvedRevision ?? baseRevision);
}
