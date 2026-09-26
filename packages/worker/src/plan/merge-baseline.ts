import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { Database } from '@haive/database';
import {
  captureFixBaseline,
  recordFixerLeftovers,
  relocateFixerChanges,
  type FixBaseline,
  type FixBaselineUnavailable,
} from '../step-engine/git-merge.js';
import { taskSecretMaskPolicy } from '../queues/cli-exec/secret-mask.js';
import { gitRun } from '../repo/git-push.js';

/** Kept beside the transcript, and for its reason: a Retry and the revise loop reset the step row,
 *  and a merge a cancelled conversation left open is resumed by the next one. */
export const PLAN_MERGE_BASELINE_EVENT = 'plan_merge.fix_baseline';

export interface RecordedFixBaseline {
  baseline: FixBaseline | FixBaselineUnavailable;
  taskId: string;
  taskStepId: string | null;
}

async function revParse(dir: string, spec: string): Promise<string | null> {
  const res = await gitRun(dir, ['rev-parse', '-q', '--verify', spec]);
  return res.code === 0 ? res.stdout.trim() : null;
}

async function openMergeIds(dir: string): Promise<{ head: string; mergeHead: string } | null> {
  const [head, mergeHead] = await Promise.all([revParse(dir, 'HEAD'), revParse(dir, 'MERGE_HEAD')]);
  return head !== null && mergeHead !== null ? { head, mergeHead } : null;
}

/** The newest tree recorded for the repository, while the merge it was taken of is still open. */
async function recordedFixBaseline(
  db: Database,
  repositoryId: string,
  worktreePath: string,
): Promise<RecordedFixBaseline | null> {
  const open = await openMergeIds(worktreePath);
  if (!open) return null;
  const [row] = await db
    .select({
      taskId: schema.taskEvents.taskId,
      taskStepId: schema.taskEvents.taskStepId,
      payload: schema.taskEvents.payload,
    })
    .from(schema.taskEvents)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskEvents.taskId))
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.taskEvents.eventType, PLAN_MERGE_BASELINE_EVENT),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt))
    .limit(1);
  const recorded = row?.payload as
    | { baseline?: FixBaseline | FixBaselineUnavailable; head?: string; mergeHead?: string }
    | undefined;
  if (!row || !recorded?.baseline) return null;
  if (recorded.head !== open.head || recorded.mergeHead !== open.mergeHead) return null;
  return { baseline: recorded.baseline, taskId: row.taskId, taskStepId: row.taskStepId };
}

/** One tree per open merge, so a fixer that failed or was stopped is compared with it too. A merge
 *  this pass opened is a new tree, even where a merge of the same two commits was recorded. */
export async function planMergeFixBaseline(
  db: Database,
  at: { repositoryId: string; taskId: string; taskStepId: string; worktreePath: string },
  opened: boolean,
): Promise<FixBaseline | FixBaselineUnavailable | null> {
  if (!opened) {
    const recorded = await recordedFixBaseline(db, at.repositoryId, at.worktreePath);
    if (recorded) return recorded.baseline;
  }
  const baseline = await captureFixBaseline(at.worktreePath, () =>
    taskSecretMaskPolicy(db, at.taskId),
  );
  const open = await openMergeIds(at.worktreePath);
  // One git could not record is kept too: a later capture would absorb what a fixer changed.
  if (baseline && open) {
    await db.insert(schema.taskEvents).values({
      taskId: at.taskId,
      taskStepId: at.taskStepId,
      eventType: PLAN_MERGE_BASELINE_EVENT,
      payload: { baseline, ...open },
    });
  }
  return baseline;
}

/** Move aside what fixers left in the merge `recorded` was taken of, reported on its task. */
export async function moveAsideFixerLeftovers(
  db: Database,
  worktreePath: string,
  recorded: RecordedFixBaseline,
  branch: string,
): Promise<void> {
  const leftovers = await relocateFixerChanges(
    worktreePath,
    recorded.baseline,
    { taskId: recorded.taskId, runId: randomUUID() },
    () => taskSecretMaskPolicy(db, recorded.taskId),
  );
  if (leftovers) {
    await recordFixerLeftovers(db, recorded.taskId, recorded.taskStepId, branch, leftovers);
  }
}

/** What fixers left in a merge a conversation left open, moved aside before it is discarded. */
export async function moveAsideRecordedLeftovers(
  db: Database,
  repositoryId: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const recorded = await recordedFixBaseline(db, repositoryId, worktreePath);
  if (recorded) await moveAsideFixerLeftovers(db, worktreePath, recorded, branch);
}
