import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  MERGE_LANDED_EVENT,
  MERGE_LEFT_COMMITTED_EVENT,
  readLandedMerge,
} from '@haive/shared/merge-left-open';
import { gitRun } from '../repo/git-push.js';
import { GIT_TIMED_OUT } from '../repo/git-exec.js';
import { inMergeDirLock, type DbHandle } from './merge-dir-claim.js';
export { undoLeftMerge } from './undo-left-merge.js';

const records = (db: DbHandle, taskId: string) =>
  db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [MERGE_LANDED_EVENT, MERGE_LEFT_COMMITTED_EVENT]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));

/** Report once, before cancel releases the merge-dir claim and marks teardown finished. A
 * pushed merge and a person's checkout get the same report. Only reads git; never undoes it.
 * The directory lock serialises duplicate CANCEL/abandon passes with the landing writer. */
export async function recordLeftCommittedMerge(
  db: Database,
  taskId: string,
  recordedDirs: readonly string[] = [],
): Promise<void> {
  const known = await records(db, taskId);
  if (known.some((e) => e.eventType === MERGE_LEFT_COMMITTED_EVENT)) return;
  const latest = known.filter((e) => e.eventType === MERGE_LANDED_EVENT).at(-1);
  const merge = readLandedMerge(latest?.payload);
  // An unlocked read may skip a report already written, but never decide there was no
  // landing while a recorded directory's section can still be committing it. The event's
  // directory also covers a landing whose step has since been reset or removed.
  const dirs = new Set([...recordedDirs, ...(merge ? [merge.dir] : [])]);
  for (const dir of dirs) {
    await inMergeDirLock(db, dir, async (tx) => {
      const task = await tx.query.tasks.findFirst({
        where: eq(schema.tasks.id, taskId),
        columns: { status: true },
      });
      if (task?.status !== 'cancelled') return;
      const events = await records(tx, taskId);
      if (events.some((e) => e.eventType === MERGE_LEFT_COMMITTED_EVENT)) return;
      // Re-read under the lock: a section finishing its merge/squash may have committed since
      // the first read. Pin the local branch, not HEAD (the checkout may be on another branch).
      const landed = readLandedMerge(
        events.filter((e) => e.eventType === MERGE_LANDED_EVENT).at(-1)?.payload,
      );
      if (!landed || landed.dir !== dir) return;
      const contains = await gitRun(landed.repoPath, [
        'merge-base',
        '--is-ancestor',
        landed.baseShaAfter,
        `refs/heads/${landed.landedOn}`,
      ]);
      if (contains.code === 1) return;
      if (contains.code === GIT_TIMED_OUT)
        throw new Error(`Cannot check the cancelled task's landed merge: ${contains.stderr}`);
      if (contains.code !== 0) {
        // A deleted branch/repository or an invalid object cannot be repaired by re-driving
        // cancel. Leave it unreported rather than holding the claims and teardown forever.
        logger.warn(
          {
            taskId,
            dir: landed.dir,
            landedOn: landed.landedOn,
            code: contains.code,
            noExit: contains.noExit,
          },
          "Cannot confirm the cancelled task's landed merge; cancel teardown continues",
        );
        return;
      }
      const step = await tx.query.taskSteps.findFirst({
        where: and(
          eq(schema.taskSteps.taskId, taskId),
          eq(schema.taskSteps.stepId, '12-worktree-cleanup'),
        ),
        orderBy: desc(schema.taskSteps.round),
        columns: { mergeResolveState: true },
      });
      await tx.insert(schema.taskEvents).values({
        taskId,
        taskStepId: null,
        eventType: MERGE_LEFT_COMMITTED_EVENT,
        payload: { ...landed, pushed: step?.mergeResolveState?.pushed === true },
      });
    });
  }
}
