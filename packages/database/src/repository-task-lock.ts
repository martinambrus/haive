import { and, eq, inArray, ne, sql } from 'drizzle-orm';
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

/** How long a request or the worker's upgrade apply waits for a lock on a repository (its task-creation
 *  key, a plan or project-state key, or its row) before giving up. */
export const REPOSITORY_TASKS_LOCK_TIMEOUT_MS = 30_000;

/** Admission waits for repository/plan keys and rows. Measured with 512 claim files: the
 *  longest foreground hold was 2.072 s, the sweep 1.735 s; 1,000-file git sections took
 *  118-131 ms. Five seconds leaves routine writers headroom while bounding pool occupancy.
 *  The hold grows with the record: about 1,300-1,800 claim files fill 5 s, and a record at its
 *  4,096-entry ceiling holds about 10-14 s, so a start behind such a write answers 409 busy. */
export const TASK_START_LOCK_TIMEOUT_MS = 5_000;

/** The exclusive maintenance holder only toggles state; it needs no filesystem/git budget. */
export const NEW_WORK_FENCE_LOCK_TIMEOUT_MS = 1_000;

/** The shared lock-wait mechanism. A timeout aborts the transaction; callers translate it only
 * after giving up the transaction, and never continue using state read before the wait. */
export async function boundedLockWait<T>(
  tx: DbTx,
  take: () => Promise<T>,
  timeoutMs = REPOSITORY_TASKS_LOCK_TIMEOUT_MS,
): Promise<T> {
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`));
  const result = await take();
  // Later writes retain their ordinary wait policy.
  await tx.execute(sql.raw('SET LOCAL lock_timeout = DEFAULT'));
  return result;
}

/** The repository's task-creation lock alone, without the row: a checkout move holds it so no task is
 *  created between its last check and the move, while plain inserts still go through. */
export async function lockRepositoryTasksKey(tx: DbTx, repositoryId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`onboarding-upgrade:${repositoryId}`}, 0))`,
  );
}

/** Take the lock every creator and reviver of an onboarding or upgrade of one repository shares,
 *  then the repository row, and return the row (undefined when there is none). */
export async function lockRepositoryRow(tx: DbTx, repositoryId: string) {
  await lockRepositoryTasksKey(tx, repositoryId);
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
  excludeTaskId?: string,
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
        ...(excludeTaskId ? [ne(schema.tasks.id, excludeTaskId)] : []),
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
  type: string;
  userId: string;
  repositoryId: string | null;
  metadata: unknown;
}

export type ReviveCheck =
  | { task: ReviveTask; refusal: ReviveRefusal; repo?: undefined }
  | { task: ReviveTask; refusal: null; repo: LockedRepository };

/**
 * The checks that decide whether a failed onboarding or upgrade may be revived, under the lock
 * creation takes: a live root claim, then an onboarding beside a live upgrade, rollback or other
 * onboarding, or an upgrade or rollback beside a live onboarding. Call it in the transaction that
 * revives the task. Every type proves its repository still exists after taking the creation key.
 * A task created repo-less may explicitly opt out of the missing-repository refusal.
 */
export async function checkRevive(
  tx: DbTx,
  taskId: string,
  allowNoRepository = false,
): Promise<ReviveCheck | null> {
  const [row] = await tx
    .select({
      type: schema.tasks.type,
      userId: schema.tasks.userId,
      repositoryId: schema.tasks.repositoryId,
      metadata: schema.tasks.metadata,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  if (!row) return null;
  if (!row.repositoryId) {
    return allowNoRepository ? null : { task: row, refusal: { reason: 'no-repository' } };
  }
  // Deletion takes this key too. A read before the wait cannot prove the repository survived it.
  if (row.type !== 'onboarding' && row.type !== 'onboarding_upgrade') {
    await lockRepositoryTasksKey(tx, row.repositoryId);
    const [repo] = await tx
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, row.repositoryId));
    return repo ? null : { task: row, refusal: { reason: 'no-repository' } };
  }
  const task: ReviveTask & { repositoryId: string } = {
    type: row.type,
    userId: row.userId,
    repositoryId: row.repositoryId,
    metadata: row.metadata,
  };
  const repo = await lockRepositoryRow(tx, task.repositoryId);
  if (!repo) return { task, refusal: { reason: 'no-repository' } };
  const [current] = await tx
    .select({ status: schema.tasks.status, deadAt: schema.tasks.deadAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  // Dead tasks keep their live status but gave up the checkout; revival must re-admit them.
  // An active task's Retry/Resume retains the existing admission behaviour.
  if (
    !current ||
    (!current.deadAt && (LIVE_TASK_STATUSES as readonly string[]).includes(current.status))
  )
    return null;
  if (isRootClaimLive(repo.rootClaimedAt)) {
    return {
      task,
      refusal: { reason: 'root-claim', claimKind: repo.rootClaimKind as RootClaimKind | null },
    };
  }
  let refusal: ReviveRefusal | null = null;
  if (task.type === 'onboarding') {
    const upgradeId = await liveTaskIdOfType(
      tx,
      task.repositoryId,
      'onboarding_upgrade',
      undefined,
      taskId,
    );
    if (upgradeId) refusal = { reason: 'live-upgrade', taskId: upgradeId };
  }
  if (!refusal) {
    const onboardingId = await liveTaskIdOfType(
      tx,
      task.repositoryId,
      'onboarding',
      task.userId,
      taskId,
    );
    if (onboardingId) refusal = { reason: 'live-onboarding', taskId: onboardingId };
  }
  return refusal ? { task, refusal } : { task, repo, refusal: null };
}
