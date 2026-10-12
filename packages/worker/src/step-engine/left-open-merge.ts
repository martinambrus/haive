import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { schema, type Database, type MergeResolveState } from '@haive/database';
import {
  leftOpenMerges,
  logger,
  MERGE_LEFT_OPEN_EVENT,
  MERGE_LEFT_OPEN_SETTLED_EVENT,
  type AbortLeftMergePayload,
  type LeftOpenMerge,
  type MergeLeftOpenOutcome,
} from '@haive/shared';
import { taskSecretMaskPolicy } from '../queues/cli-exec/secret-mask.js';
import {
  abortFailureNote,
  abortMerge,
  isHostCheckout,
  mergeOpenFor,
  recordFixerLeftovers,
  relocateFixerChanges,
  revParse,
  type FixBaseline,
  type FixBaselineUnavailable,
  type FixerLeftovers,
  type SecretMaskSource,
} from './git-merge.js';
import { inMergeDirLock, liveClaimHolder } from './merge-dir-claim.js';
import { addStepWarning } from './step-ownership.js';
import type { TaskStepRow } from './step-runner.js';

// A cancel runs no step code, so a merge a fixer was resolving stays open where it ran. The cancel
// reports it (`recordLeftOpenMerges`), the person's confirmed click aborts it (`abortLeftMerge`),
// and the next resolver to clear it settles the report (`noteAbortedByNext`). Nothing here aborts
// on its own: the cancel cannot prove the open merge is the task's.

/** Merge phases that can have the task's merge open: after them it is committed or aborted. */
const MID_MERGE_PHASES: ReadonlySet<MergeResolveState['phase']> = new Set([
  'pending',
  'resolving',
  'awaiting-guidance',
  'squashing',
]);

export interface OpenMerge {
  head: string;
  mergeHead: string;
}

interface RecordedMerge {
  dir: string;
  ref: string;
  stepId: string;
  fixInvocationId: string | null;
  fixBaseline: FixBaseline | FixBaselineUnavailable | null;
}

/** HEAD and MERGE_HEAD of the merge open in `dir`, or null when none is. */
export async function peekOpenMerge(dir: string): Promise<OpenMerge | null> {
  const mergeHead = await revParse(dir, 'MERGE_HEAD');
  const head = mergeHead === null ? null : await revParse(dir, 'HEAD');
  return mergeHead === null || head === null ? null : { head, mergeHead };
}

/** The merges the task's rows say were in progress: a resolver step's merge dir, and the task's
 *  integration worktree while a DAG level merge has a conflict in flight. */
async function recordedMerges(db: Database, taskId: string): Promise<RecordedMerge[]> {
  const merges: RecordedMerge[] = [];
  const steps = await db
    .select({ id: schema.taskSteps.id, state: schema.taskSteps.mergeResolveState })
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), isNotNull(schema.taskSteps.mergeResolveState)));
  for (const { id, state } of steps) {
    if (!state || !MID_MERGE_PHASES.has(state.phase)) continue;
    merges.push({
      dir: state.mergeDir,
      ref: state.featureBranch,
      stepId: id,
      fixInvocationId: state.fixInvocationId,
      fixBaseline: state.fixBaseline ?? null,
    });
  }
  const [task] = await db
    .select({ worktreePath: schema.tasks.worktreePath })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  if (!task?.worktreePath) return merges;
  const levels = await db
    .select({ state: schema.taskDagLevels.mergeState, stepId: schema.taskDagPlans.taskStepId })
    .from(schema.taskDagLevels)
    .innerJoin(schema.taskDagPlans, eq(schema.taskDagPlans.id, schema.taskDagLevels.dagPlanId))
    .where(eq(schema.taskDagPlans.taskId, taskId));
  for (const { state, stepId } of levels) {
    const ms = state as {
      activeConflict?: string | null;
      fixInvocationId?: string | null;
      fixBaseline?: FixBaseline | FixBaselineUnavailable | null;
    } | null;
    if (!ms?.activeConflict) continue;
    const [issue] = await db
      .select({ branchName: schema.taskDagIssues.branchName })
      .from(schema.taskDagIssues)
      .where(
        and(
          eq(schema.taskDagIssues.taskId, taskId),
          eq(schema.taskDagIssues.issueKey, ms.activeConflict),
        ),
      );
    if (!issue?.branchName) continue;
    merges.push({
      dir: task.worktreePath,
      ref: issue.branchName,
      stepId,
      fixInvocationId: ms.fixInvocationId ?? null,
      fixBaseline: ms.fixBaseline ?? null,
    });
  }
  return merges;
}

async function taskLeftOpen(db: Database, taskId: string): Promise<LeftOpenMerge[]> {
  const rows = await db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [
          MERGE_LEFT_OPEN_EVENT,
          MERGE_LEFT_OPEN_SETTLED_EVENT,
        ]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  return leftOpenMerges(rows);
}

async function settle(
  db: Database,
  taskId: string,
  merge: Pick<LeftOpenMerge, 'dir' | 'mergeHead'>,
  outcome: MergeLeftOpenOutcome,
  reason: string,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId: null,
    eventType: MERGE_LEFT_OPEN_SETTLED_EVENT,
    payload: { dir: merge.dir, mergeHead: merge.mergeHead, outcome, reason },
  });
}

/** Report each merge the cancelled task's rows recorded that is still open in its directory and
 *  names the ref the task was merging. Once per directory and merge head, so a re-driven cancel
 *  adds nothing. Called after the claims are released, once no sandbox of the task is left. */
export async function recordLeftOpenMerges(db: Database, taskId: string): Promise<void> {
  try {
    const known = await taskLeftOpen(db, taskId);
    for (const recorded of await recordedMerges(db, taskId)) {
      if (isHostCheckout(recorded.dir)) continue;
      if (!(await mergeOpenFor(recorded.dir, recorded.ref))) continue;
      const open = await peekOpenMerge(recorded.dir);
      if (!open) continue;
      if (known.some((k) => k.dir === recorded.dir && k.mergeHead === open.mergeHead)) continue;
      const payload = { dir: recorded.dir, ref: recorded.ref, ...open };
      await db.insert(schema.taskEvents).values({
        taskId,
        taskStepId: recorded.stepId,
        eventType: MERGE_LEFT_OPEN_EVENT,
        payload,
      });
      known.push({ ...payload, settled: null });
    }
  } catch (err) {
    logger.warn({ err, taskId }, 'recording the merges a cancel left open failed');
  }
}

async function maskSourceOnce(db: Database, taskId: string): Promise<SecretMaskSource> {
  const read = await taskSecretMaskPolicy(db, taskId).then(
    (policy) => ({ policy }),
    (error: unknown) => ({ error }),
  );
  return async () => {
    if ('error' in read) throw read.error;
    return read.policy;
  };
}

interface AbortDecision {
  outcome: MergeLeftOpenOutcome;
  reason: string;
  leftovers?: FixerLeftovers | null;
}

/** Abort the merge a cancelled task left open in `payload.dir`, on the person's confirmed click.
 *  The directory must name a report of this task still unsettled. Under the directory's lock it
 *  refuses while a live task holds the directory, and aborts only a merge whose HEAD and MERGE_HEAD
 *  are the reported ones: anything else changed since, and nothing is done. Never throws: the
 *  outcome is the settled event. */
export async function abortLeftMerge(db: Database, payload: AbortLeftMergePayload): Promise<void> {
  const { taskId, dir } = payload;
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { status: true },
    });
    if (task?.status !== 'cancelled') return;
    const reported = (await taskLeftOpen(db, taskId)).filter(
      (m) => m.dir === dir && m.settled === null,
    );
    const target = reported.at(-1);
    if (!target) return;
    const recorded = (await recordedMerges(db, taskId)).find((m) => m.dir === dir);
    const baseline =
      recorded?.fixBaseline &&
      'tree' in recorded.fixBaseline &&
      recorded.fixBaseline.head === target.head &&
      recorded.fixBaseline.mergeHead === target.mergeHead
        ? recorded.fixBaseline
        : null;
    const maskSource = await maskSourceOnce(db, taskId);

    const decision = await inMergeDirLock(db, dir, async (tx): Promise<AbortDecision> => {
      const [claim] = await tx
        .select()
        .from(schema.mergeDirClaims)
        .where(eq(schema.mergeDirClaims.mergeDir, dir))
        .for('update');
      const holder = claim ? await liveClaimHolder(tx, claim) : null;
      if (holder) {
        return {
          outcome: 'refused',
          reason: `Task "${holder.title}" (${holder.id}) is merging in this directory; abort once it finishes.`,
        };
      }
      const open = await peekOpenMerge(dir);
      if (!open || open.head !== target.head || open.mergeHead !== target.mergeHead) {
        return {
          outcome: 'moved',
          reason:
            'The merge in this directory is no longer the one the cancel left; nothing was changed.',
        };
      }
      const leftovers = baseline
        ? await relocateFixerChanges(
            dir,
            baseline,
            { taskId, runId: recorded?.fixInvocationId ?? randomUUID() },
            maskSource,
          )
        : null;
      const aborted = await abortMerge(dir);
      if (!aborted.ok) return { outcome: 'refused', reason: abortFailureNote(aborted), leftovers };
      const unchecked = baseline
        ? ''
        : ' Files the fixer changed outside the conflict were not checked: no record of the tree it was sent into remains.';
      return {
        outcome: 'aborted',
        reason: `The checkout is back to how it was before the merge.${unchecked}`,
        leftovers,
      };
    });
    if (decision.leftovers) {
      await recordFixerLeftovers(
        db,
        taskId,
        recorded?.stepId ?? null,
        target.ref,
        decision.leftovers,
      );
    }
    await settle(db, taskId, target, decision.outcome, decision.reason);
  } catch (err) {
    logger.warn({ err, taskId, dir }, 'aborting the merge a cancel left open failed');
    const target = (await taskLeftOpen(db, taskId).catch(() => [])).find(
      (m) => m.dir === dir && m.settled === null,
    );
    if (target) {
      await settle(
        db,
        taskId,
        target,
        'refused',
        `The abort failed: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => undefined);
    }
  }
}

/** A resolver cleared the merge `before` it was about to open its own. If that was one a cancelled
 *  task left open, the report is settled and the step says so. */
export async function noteAbortedByNext(
  db: Database,
  row: TaskStepRow,
  taskId: string,
  dir: string,
  before: OpenMerge,
): Promise<TaskStepRow> {
  const owners = await db
    .selectDistinct({ taskId: schema.taskEvents.taskId, title: schema.tasks.title })
    .from(schema.taskEvents)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskEvents.taskId))
    .where(
      and(
        eq(schema.taskEvents.eventType, MERGE_LEFT_OPEN_EVENT),
        ne(schema.taskEvents.taskId, taskId),
        sql`${schema.taskEvents.payload}->>'dir' = ${dir}`,
        sql`${schema.taskEvents.payload}->>'head' = ${before.head}`,
        sql`${schema.taskEvents.payload}->>'mergeHead' = ${before.mergeHead}`,
      ),
    );
  let current = row;
  for (const owner of owners) {
    const merge = (await taskLeftOpen(db, owner.taskId)).find(
      (m) => m.dir === dir && m.mergeHead === before.mergeHead && m.settled === null,
    );
    if (!merge) continue;
    await settle(
      db,
      owner.taskId,
      merge,
      'aborted-by-next',
      `Another task's merge needed the directory and cleared it first.`,
    );
    current = await addStepWarning(
      db,
      current,
      `A merge of ${merge.ref} that the cancelled task "${owner.title}" (${owner.taskId}) left open in ${dir} was aborted before this merge started.`,
    );
  }
  return current;
}
