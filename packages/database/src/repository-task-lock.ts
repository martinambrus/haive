import { and, eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema/index.js';
import { isRootClaimLive, type RootClaimKind } from './repo-root-claim.js';
import type { DbTx } from './task-attachments-lock.js';
import type { Database } from './index.js';

/** Task statuses an onboarding or upgrade can hold while it still has work to do; the complement
 *  of the terminal three, and the statuses `tasks_one_live_upgrade_per_repo_idx` is built on. */
export const LIVE_TASK_STATUSES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

/** Take the lock every creator and reviver of an onboarding or upgrade of one repository shares,
 *  then the repository row, and return the row (undefined when there is none). */
export async function lockRepositoryRow(tx: DbTx, repositoryId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`onboarding-upgrade:${repositoryId}`}, 0))`,
  );
  const [repo] = await tx
    .select({
      id: schema.repositories.id,
      source: schema.repositories.source,
      renderContext: schema.repositories.renderContext,
      status: schema.repositories.status,
      storagePath: schema.repositories.storagePath,
      localPath: schema.repositories.localPath,
      onboardedAt: schema.repositories.onboardedAt,
      onboardingResetAt: schema.repositories.onboardingResetAt,
      rootClaimedAt: schema.repositories.rootClaimedAt,
      rootClaimKind: schema.repositories.rootClaimKind,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .for('update');
  return repo;
}

export type LockedRepository = NonNullable<Awaited<ReturnType<typeof lockRepositoryRow>>>;

/** The id of a live task of `type` on the repository, or null. */
export async function liveTaskIdOfType(
  db: Database | DbTx,
  repositoryId: string,
  type: 'onboarding' | 'onboarding_upgrade',
  userId?: string,
): Promise<string | null> {
  const [live] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, type),
        inArray(schema.tasks.status, [...LIVE_TASK_STATUSES]),
        ...(userId ? [eq(schema.tasks.userId, userId)] : []),
      ),
    )
    .limit(1);
  return live?.id ?? null;
}

export type ReviveRefusal =
  | { reason: 'no-repository' }
  | { reason: 'root-claim'; claimKind: RootClaimKind | null }
  | { reason: 'live-upgrade'; taskId: string }
  | { reason: 'live-onboarding'; taskId: string };

export interface ReviveTask {
  type: 'onboarding' | 'onboarding_upgrade';
  userId: string;
  repositoryId: string;
  metadata: unknown;
}

export type ReviveCheck =
  | { task: ReviveTask; refusal: ReviveRefusal; repo?: undefined }
  | { task: ReviveTask; refusal: null; repo: LockedRepository };

/**
 * The checks that decide whether a failed onboarding or upgrade may be revived, under the lock
 * creation takes: a live root claim, then an onboarding beside a live upgrade or rollback, or an
 * upgrade or rollback beside a live onboarding. Call it in the transaction that revives the task.
 * Null when the task is of another type, has no repository, or is already live.
 */
export async function checkRevive(tx: DbTx, taskId: string): Promise<ReviveCheck | null> {
  const [row] = await tx
    .select({
      type: schema.tasks.type,
      userId: schema.tasks.userId,
      repositoryId: schema.tasks.repositoryId,
      metadata: schema.tasks.metadata,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  if (!row?.repositoryId || (row.type !== 'onboarding' && row.type !== 'onboarding_upgrade')) {
    return null;
  }
  const task: ReviveTask = {
    type: row.type,
    userId: row.userId,
    repositoryId: row.repositoryId,
    metadata: row.metadata,
  };
  const repo = await lockRepositoryRow(tx, task.repositoryId);
  if (!repo) return { task, refusal: { reason: 'no-repository' } };
  if (isRootClaimLive(repo.rootClaimedAt)) {
    return {
      task,
      refusal: { reason: 'root-claim', claimKind: repo.rootClaimKind as RootClaimKind | null },
    };
  }
  const [current] = await tx
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  if (!current || (LIVE_TASK_STATUSES as readonly string[]).includes(current.status)) return null;
  let refusal: ReviveRefusal | null = null;
  if (task.type === 'onboarding') {
    const liveId = await liveTaskIdOfType(tx, task.repositoryId, 'onboarding_upgrade');
    if (liveId) refusal = { reason: 'live-upgrade', taskId: liveId };
  } else {
    const liveId = await liveTaskIdOfType(tx, task.repositoryId, 'onboarding', task.userId);
    if (liveId) refusal = { reason: 'live-onboarding', taskId: liveId };
  }
  return refusal ? { task, refusal } : { task, repo, refusal: null };
}
