import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema, type DbTx } from '@haive/database';
import { decideTaskWorktree } from './task-worktree.js';
import { liveClaimHolder } from './merge-dir-claim.js';
import {
  leftOpenMerges,
  MERGE_LEFT_OPEN_EVENT,
  MERGE_LEFT_OPEN_SETTLED_EVENT,
} from './merge-left-open.js';

export const ROOT_MERGE_BUSY_MESSAGE =
  'A merge is still open in the repository checkout. Finish or abort it, then try again.';

/** Called only while holding lockRepositoryTasksKey, which also guards opening a root merge.
 *  The dir claim covers live/retryable merges; cancelled mergers release that claim only
 *  after recording the merge they left open. Cross-branch worktrees do not hold the root. */
export async function rootMergeBusy(
  tx: DbTx,
  taskId: string,
  task: { repositoryId: string; worktreePath?: string | null; worktreeBranch?: string | null },
): Promise<boolean> {
  const repo = await tx.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { storagePath: true, localPath: true },
  });
  const root = repo?.storagePath ?? repo?.localPath;
  if (!root) return false;
  const latest = await tx.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '01-worktree-setup'),
    ),
    orderBy: [desc(schema.taskSteps.round)],
    columns: { status: true, output: true },
  });
  const decision = decideTaskWorktree({
    columnPath: task.worktreePath,
    columnBranch: task.worktreeBranch,
    latestStatus: latest?.status,
    output: latest?.output,
  });
  if (decision.kind !== 'root') return false;

  const claim = await tx.query.mergeDirClaims.findFirst({
    where: eq(schema.mergeDirClaims.mergeDir, root),
    columns: { taskStepId: true, taskId: true },
  });
  if (claim && (await liveClaimHolder(tx, claim))) {
    const step = await tx.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, claim.taskStepId),
      columns: { mergeResolveState: true },
    });
    const state = step?.mergeResolveState;
    if (state?.mode === 'same-branch' && state.phase !== 'done' && state.phase !== 'pushing') {
      return true;
    }
  }
  // A cancelled task releases its claim but keeps its merge and report until explicitly settled.
  const events = await tx.query.taskEvents.findMany({
    where: and(
      inArray(schema.taskEvents.eventType, [MERGE_LEFT_OPEN_EVENT, MERGE_LEFT_OPEN_SETTLED_EVENT]),
      sql`${schema.taskEvents.payload} ->> 'dir' = ${root}`,
    ),
    orderBy: [asc(schema.taskEvents.createdAt)],
    columns: { eventType: true, payload: true },
  });
  if (leftOpenMerges(events).some((merge) => merge.settled === null)) return true;
  return false;
}

/** Lock before reading the task's checkout decision, and keep the lock through its re-drive. */
export async function taskRootMergeBusy(tx: DbTx, taskId: string): Promise<boolean> {
  const before = await tx.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  if (!before?.repositoryId) return false;
  await lockRepositoryTasksKey(tx, before.repositoryId);
  const task = await tx.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true, worktreePath: true, worktreeBranch: true },
  });
  if (!task?.repositoryId) return false;
  return rootMergeBusy(tx, taskId, { ...task, repositoryId: task.repositoryId });
}
