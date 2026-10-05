import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  schema,
  initializeTaskDatabaseState,
  withDatabaseSnapshotLock,
  snapshotPromotionAllowed,
  type Database,
  type DbTx,
} from '@haive/database';
import { logger } from '@haive/shared';
import { databaseSnapshotRel } from '@haive/shared/database-snapshot-files';
import { openFileNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import {
  assertOwnsStep,
  StepSupersededError,
  taskWriteTarget,
} from '../step-engine/step-ownership.js';
import type { StepContext } from '../step-engine/step-definition.js';

export const DATABASE_SAVE_STEP_ID = '11g-save-database';
export const databaseSnapshotStorageRoot = () =>
  process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
type Snapshot = typeof schema.databaseSnapshots.$inferSelect;

export async function verifyDatabaseSnapshotFile(
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<void> {
  const file = await openFileNoFollow(
    databaseSnapshotStorageRoot(),
    databaseSnapshotRel(snapshot),
    'read',
    { strict: true },
  );
  if (!file) throw new Error('The saved database file is missing');
  try {
    const stat = await file.stat();
    if (snapshot.sizeBytes === null || stat.size !== snapshot.sizeBytes || !snapshot.sha256)
      throw new Error('The saved database file is incomplete');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false, signal }))
      hash.update(chunk);
    if (hash.digest('hex') !== snapshot.sha256)
      throw new Error('The saved database file failed its checksum check');
  } finally {
    await file.close();
  }
}

export async function loadDatabaseSnapshotState(ctx: StepContext) {
  const task = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
  if (!task) throw new StepSupersededError(ctx.taskStepId);
  let state = await initializeTaskDatabaseState(ctx.db, task);
  if (!state) return null;
  // An upstream Retry advances the task epoch. It needs a fresh export after its new work;
  // duplicate delivery in the same epoch must keep the decision that already committed.
  if (state.outcome !== 'pending' && state.decisionEpoch !== task.orchestrationEpoch) {
    state = await withSnapshotStep(ctx, task.orchestrationEpoch, async (tx) => {
      const [updated] = await tx
        .update(schema.taskDatabaseStates)
        .set({
          outcome: 'pending',
          candidateSnapshotId: null,
          candidateStepId: null,
          exportError: null,
          decisionEpoch: null,
        })
        .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId))
        .returning();
      return updated!;
    });
  }
  const head = await ctx.db.query.repositoryDatabaseStates.findFirst({
    where: eq(schema.repositoryDatabaseStates.repositoryId, state.repositoryId),
  });
  const candidate = state.candidateSnapshotId
    ? await ctx.db.query.databaseSnapshots.findFirst({
        where: eq(schema.databaseSnapshots.id, state.candidateSnapshotId),
      })
    : null;
  const current = head?.snapshotId
    ? await ctx.db.query.databaseSnapshots.findFirst({
        where: eq(schema.databaseSnapshots.id, head.snapshotId),
      })
    : null;
  return {
    state,
    revision: head?.revision ?? 0,
    candidate: candidate ?? null,
    current: current ?? null,
    epoch: task.orchestrationEpoch,
    title: task.title,
  };
}

/** Lock the step before the task, matching Retry/Stop's ordering, then take the repository lock. */
export async function withSnapshotStep<T>(
  ctx: StepContext,
  epoch: number,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  ctx.throwIfCancelled();
  return ctx.db.transaction(async (tx) => {
    await assertOwnsStep(tx, ctx.taskStepId);
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(taskWriteTarget(ctx.taskId, { epoch }))
      .for('share');
    if (!task?.repositoryId) throw new StepSupersededError(ctx.taskStepId);
    return withDatabaseSnapshotLock(tx, task.repositoryId, fn);
  });
}

export async function reserveDatabaseSnapshot(
  ctx: StepContext,
  epoch: number,
  metadata: { engine: string; engineVersion: string | null; codeCommit: string | null },
) {
  return withSnapshotStep(ctx, epoch, async (tx) => {
    const state = await tx.query.taskDatabaseStates.findFirst({
      where: eq(schema.taskDatabaseStates.taskId, ctx.taskId),
    });
    const task = await tx.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
    if (!state || !task) throw new StepSupersededError(ctx.taskStepId);
    const [snapshot] = await tx
      .insert(schema.databaseSnapshots)
      .values({
        id: randomUUID(),
        repositoryId: state.repositoryId,
        userId: ctx.userId,
        sourceTaskId: ctx.taskId,
        sourceTaskTitle: task.title,
        parentSnapshotId: state.sourceSnapshotId,
        ...metadata,
      })
      .returning();
    await tx
      .update(schema.taskDatabaseStates)
      .set({
        candidateSnapshotId: snapshot!.id,
        candidateStepId: ctx.taskStepId,
        exportError: null,
      })
      .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
    return snapshot!;
  });
}

export async function promoteDatabaseSnapshot(
  ctx: StepContext,
  epoch: number,
  approvedRevision?: number,
): Promise<'saved' | 'conflict'> {
  return withSnapshotStep(ctx, epoch, async (tx) => {
    const state = await tx.query.taskDatabaseStates.findFirst({
      where: eq(schema.taskDatabaseStates.taskId, ctx.taskId),
    });
    if (state?.outcome === 'saved') return 'saved';
    const candidate = state?.candidateSnapshotId
      ? await tx.query.databaseSnapshots.findFirst({
          where: eq(schema.databaseSnapshots.id, state.candidateSnapshotId),
        })
      : null;
    if (!state || candidate?.status !== 'ready')
      throw new Error('No complete database snapshot to save');
    const head = await tx.query.repositoryDatabaseStates.findFirst({
      where: eq(schema.repositoryDatabaseStates.repositoryId, state.repositoryId),
    });
    if (!head || !snapshotPromotionAllowed(state.baseRevision, head.revision, approvedRevision))
      return 'conflict';
    await tx
      .update(schema.repositoryDatabaseStates)
      .set({ snapshotId: candidate.id, revision: head.revision + 1 })
      .where(eq(schema.repositoryDatabaseStates.repositoryId, state.repositoryId));
    await tx
      .update(schema.taskDatabaseStates)
      .set({
        outcome: 'saved',
        exportError: null,
        decisionEpoch: epoch,
        baseRevision: head.revision + 1,
      })
      .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
    return 'saved';
  });
}

export async function discardDatabaseSnapshot(ctx: StepContext, epoch: number) {
  await withSnapshotStep(ctx, epoch, async (tx) => {
    await tx
      .update(schema.taskDatabaseStates)
      .set({ outcome: 'discarded', exportError: null, decisionEpoch: epoch })
      .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
  });
  await sweepDatabaseSnapshots(ctx.db);
}

/** References are pins only while the owning task can use them. A skipped save releases its candidate. */
function unreferenced() {
  return sql`NOT EXISTS (SELECT 1 FROM repository_database_states h WHERE h.snapshot_id = database_snapshots.id)
    AND NOT EXISTS (
      SELECT 1 FROM task_database_states s JOIN tasks t ON t.id = s.task_id
      WHERE t.status NOT IN ('completed', 'cancelled') AND (
        s.source_snapshot_id = database_snapshots.id OR
        (s.candidate_snapshot_id = database_snapshots.id AND s.outcome = 'pending'
          AND NOT EXISTS (SELECT 1 FROM task_steps p WHERE p.id = s.candidate_step_id AND p.status = 'skipped'))
      )
    )`;
}

/** Mark under the same lock as selection/promotion; remove bytes outside it. A failed removal keeps its inventory for retry. */
export async function sweepDatabaseSnapshots(db: Database): Promise<number> {
  const candidates = await db
    .select()
    .from(schema.databaseSnapshots)
    .where(unreferenced())
    .limit(100);
  let removed = 0;
  for (const snapshot of candidates) {
    try {
      const claimed = await withDatabaseSnapshotLock(db, snapshot.repositoryId, async (tx) => {
        const [row] = await tx
          .update(schema.databaseSnapshots)
          .set({ status: 'deleting' })
          .where(and(eq(schema.databaseSnapshots.id, snapshot.id), unreferenced()))
          .returning();
        return row;
      });
      if (!claimed) continue;
      await removeDatabaseSnapshotFiles(claimed);
      await db
        .delete(schema.databaseSnapshots)
        .where(
          and(
            eq(schema.databaseSnapshots.id, claimed.id),
            eq(schema.databaseSnapshots.status, 'deleting'),
          ),
        );
      removed += 1;
    } catch (err) {
      logger.warn({ err, snapshotId: snapshot.id }, 'database snapshot cleanup failed; will retry');
    }
  }
  return removed;
}

async function removeDatabaseSnapshotFiles(snapshot: Snapshot) {
  const rel = databaseSnapshotRel(snapshot);
  const anchor = databaseSnapshotStorageRoot();
  await removeNoFollow(anchor, rel);
  await removeNoFollow(anchor, `${rel}.partial`);
}

export function startDatabaseSnapshotCleanup(db: Database): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await sweepDatabaseSnapshots(db);
    } catch (err) {
      logger.warn({ err }, 'database snapshot sweep failed');
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
