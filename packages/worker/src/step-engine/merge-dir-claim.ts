import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { StepSupersededError, taskWriteTarget } from './step-ownership.js';

export type DbHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface MergeDirOwner {
  mergeDir: string;
  stepId: string;
  taskId: string;
  /** The task epoch the pass runs under; unset checks only that the task is still live. */
  epoch?: number | null;
}

export interface MergeDirHolder {
  id: string;
  title: string;
}

export type MergeDirClaim = { kind: 'claimed' } | { kind: 'held'; holder: MergeDirHolder };

const LOCK_RETRY_FIRST_MS = 100;
const LOCK_RETRY_MAX_MS = 1000;

/** Runs `fn` in a transaction holding the dir's advisory lock. The directory is keyed rather than the
 *  repository: two repository rows can share one local path. The lock is tried in a fresh
 *  transaction per attempt, so a waiter holds no pooled connection between attempts. */
export async function inMergeDirLock<T>(
  db: Database,
  mergeDir: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  let delay = LOCK_RETRY_FIRST_MS;
  for (;;) {
    const got = await db.transaction(async (tx) => {
      const rows = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`merge-dir:${mergeDir}`}, 0)) as ok`,
      );
      return rows[0]?.ok ? { value: await fn(tx) } : null;
    });
    if (got) return got.value;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
}

// A plain read, no row lock: every writer of the dir, cancel's release included, holds the dir lock,
// so a check made under it cannot go stale before the section ends. A task-row lock here would
// deadlock against a Retry, which writes its step rows before the task row.
async function requireLiveOwner(tx: DbHandle, owner: MergeDirOwner): Promise<void> {
  const fence = owner.epoch == null ? undefined : { epoch: owner.epoch };
  const live = await tx
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(taskWriteTarget(owner.taskId, fence));
  if (live.length === 0) throw new StepSupersededError(owner.stepId);
}

/** The task a claim holds the dir for, or null once the claim is stale: its task completed, its
 *  step skipped (a stale merge), or the task cancelled with its teardown recorded
 *  (`task.cancel_finished`, written after the release). */
export async function liveClaimHolder(
  tx: DbHandle,
  claim: { taskId: string; taskStepId: string },
): Promise<MergeDirHolder | null> {
  const [holder] = await tx
    .select({
      title: schema.tasks.title,
      taskStatus: schema.tasks.status,
      stepStatus: schema.taskSteps.status,
    })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskSteps.taskId))
    .where(eq(schema.taskSteps.id, claim.taskStepId));
  const [tornDown] =
    holder?.taskStatus === 'cancelled'
      ? await tx
          .select({ id: schema.taskEvents.id })
          .from(schema.taskEvents)
          .where(
            and(
              eq(schema.taskEvents.taskId, claim.taskId),
              eq(schema.taskEvents.eventType, 'task.cancel_finished'),
            ),
          )
          .limit(1)
      : [];
  if (holder && holder.taskStatus !== 'completed' && holder.stepStatus !== 'skipped' && !tornDown) {
    return { id: claim.taskId, title: holder.title };
  }
  return null;
}

/** Another task's live claim on `mergeDir`, or null. Read under the dir's lock, so it holds until the
 *  section ends. */
export async function otherLiveClaim(
  tx: DbHandle,
  mergeDir: string,
  taskId: string,
): Promise<MergeDirHolder | null> {
  const [claim] = await tx
    .select()
    .from(schema.mergeDirClaims)
    .where(eq(schema.mergeDirClaims.mergeDir, mergeDir));
  if (!claim || claim.taskId === taskId) return null;
  return liveClaimHolder(tx, claim);
}

/** Take `mergeDir` for the pass's step before its first git write, committed ahead of it. Another
 *  task's claim holds unless that task is completed, that step skipped (a stale merge), or the task
 *  is cancelled with its teardown recorded (`task.cancel_finished`, written after the release). */
export async function claimMergeDir(db: Database, owner: MergeDirOwner): Promise<MergeDirClaim> {
  return inMergeDirLock(db, owner.mergeDir, async (tx) => {
    await requireLiveOwner(tx, owner);
    const [claim] = await tx
      .select()
      .from(schema.mergeDirClaims)
      .where(eq(schema.mergeDirClaims.mergeDir, owner.mergeDir))
      .for('update');
    if (!claim) {
      await tx.insert(schema.mergeDirClaims).values({
        mergeDir: owner.mergeDir,
        taskId: owner.taskId,
        taskStepId: owner.stepId,
      });
      return { kind: 'claimed' as const };
    }
    if (claim.taskStepId === owner.stepId) return { kind: 'claimed' as const };
    if (claim.taskId !== owner.taskId) {
      const holder = await liveClaimHolder(tx, claim);
      if (holder) return { kind: 'held' as const, holder };
    }
    await tx
      .update(schema.mergeDirClaims)
      .set({ taskId: owner.taskId, taskStepId: owner.stepId, claimedAt: new Date() })
      .where(eq(schema.mergeDirClaims.mergeDir, owner.mergeDir));
    return { kind: 'claimed' as const };
  });
}

/** One host-side write to the merge dir, refused with StepSupersededError unless the claim is the
 *  pass's and its task still live at its epoch. `fn` writes the database through `tx` only. */
export async function withMergeDirSection<T>(
  db: Database,
  owner: MergeDirOwner,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return inMergeDirLock(db, owner.mergeDir, async (tx) => {
    const [claim] = await tx
      .select({ stepId: schema.mergeDirClaims.taskStepId })
      .from(schema.mergeDirClaims)
      .where(eq(schema.mergeDirClaims.mergeDir, owner.mergeDir))
      .for('update');
    if (claim?.stepId !== owner.stepId) throw new StepSupersededError(owner.stepId);
    await requireLiveOwner(tx, owner);
    return fn(tx);
  });
}

/** A write to the merge dir that must still run after the pass's own claim is gone (a cancel releases it),
 *  refused only while another task's live claim holds the dir. */
export async function inMergeDirUnlessClaimed<T>(
  db: Database,
  owner: Pick<MergeDirOwner, 'mergeDir' | 'taskId'>,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return inMergeDirLock(db, owner.mergeDir, async (tx) => {
    const holder = await otherLiveClaim(tx, owner.mergeDir, owner.taskId);
    if (holder) throw new Error(`task "${holder.title}" (${holder.id}) holds this checkout`);
    return fn(tx);
  });
}

/** Release the dir in the section that records the merge done. */
export async function releaseMergeDir(
  tx: DbHandle,
  owner: Pick<MergeDirOwner, 'mergeDir' | 'stepId'>,
): Promise<void> {
  await tx
    .delete(schema.mergeDirClaims)
    .where(
      and(
        eq(schema.mergeDirClaims.mergeDir, owner.mergeDir),
        eq(schema.mergeDirClaims.taskStepId, owner.stepId),
      ),
    );
}

/** A cancelled task's claims, once its containers (and the fixer in them) are gone. Each is released
 *  under its dir lock, so a section the old pass is still inside finishes first. */
export async function releaseTaskMergeClaims(db: Database, taskId: string): Promise<void> {
  const claims = await db
    .select({ mergeDir: schema.mergeDirClaims.mergeDir })
    .from(schema.mergeDirClaims)
    .where(eq(schema.mergeDirClaims.taskId, taskId));
  for (const { mergeDir } of claims) {
    await inMergeDirLock(db, mergeDir, (tx) =>
      tx
        .delete(schema.mergeDirClaims)
        .where(
          and(
            eq(schema.mergeDirClaims.mergeDir, mergeDir),
            eq(schema.mergeDirClaims.taskId, taskId),
          ),
        ),
    );
  }
}
