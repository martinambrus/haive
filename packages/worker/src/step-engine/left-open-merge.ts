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
import { settleProjections, type KeptMetadata } from './merge-projections.js';
import { findWorktreePathClaimant } from '../repo/worktree-claims.js';
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
  state: MergeResolveState | null;
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
      state,
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
      state: null,
    });
  }
  return merges;
}

/** Another task still working in `dir`: a live one pointing at it, or a cancelled one whose
 *  teardown has not finished, since its fixer may still be writing there. */
async function worktreeSharer(
  db: Database,
  dir: string,
  taskId: string,
): Promise<{ id: string; title: string } | null> {
  const live = await findWorktreePathClaimant(db, { worktreePath: dir, taskId });
  if (live) return live;
  const [tearingDown] = await db
    .select({ id: schema.tasks.id, title: schema.tasks.title })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.worktreePath, dir),
        ne(schema.tasks.id, taskId),
        eq(schema.tasks.status, 'cancelled'),
        sql`not exists (select 1 from ${schema.taskEvents} where ${schema.taskEvents.taskId} = ${schema.tasks.id} and ${schema.taskEvents.eventType} = 'task.cancel_finished')`,
      ),
    )
    .limit(1);
  return tearingDown ?? null;
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

/** A cancel leaves the step `failed`, which `updateOwnedStep` refuses: write its state by id. */
const saveByStepId = (db: Database, stepId: string) => async (state: MergeResolveState) => {
  await db
    .update(schema.taskSteps)
    .set({ mergeResolveState: state, updatedAt: new Date() })
    .where(eq(schema.taskSteps.id, stepId));
};

/** A merge gone before the cancel has no report: re-sync and put its files back here, never throwing. */
async function settleGoneMerge(
  db: Database,
  taskId: string,
  recorded: RecordedMerge,
): Promise<void> {
  const { state } = recorded;
  if (state?.mode !== 'same-branch') return;
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (task?.repositoryId) {
      await settleProjections(db, task.repositoryId, state, saveByStepId(db, recorded.stepId));
    }
  } catch (err) {
    logger.warn(
      { err, taskId, dir: recorded.dir },
      "a cancelled task's project files not put back",
    );
  }
}

/** Report each merge the cancelled task's rows recorded that is still open in its directory and
 *  names the ref the task was merging. Once per directory and merge head, so a re-driven cancel
 *  adds nothing. Called once no sandbox of the task is left and before its claims are released; a
 *  failure throws, so the cancel is re-driven before `task.cancel_finished` is written. */
export async function recordLeftOpenMerges(db: Database, taskId: string): Promise<void> {
  const known = await taskLeftOpen(db, taskId);
  for (const recorded of await recordedMerges(db, taskId)) {
    if (isHostCheckout(recorded.dir)) continue;
    // Under the dir's lock, so nobody clears or replaces the merge between the read and the report.
    const found = await inMergeDirLock(db, recorded.dir, async (tx) => {
      // On a re-driven cancel the claims may already be gone: a merge open under another task's
      // claim, or in a worktree a live task shares, is that task's, not this one's.
      const [claim] = await tx
        .select({ taskId: schema.mergeDirClaims.taskId })
        .from(schema.mergeDirClaims)
        .where(eq(schema.mergeDirClaims.mergeDir, recorded.dir));
      if (claim && claim.taskId !== taskId) return null;
      if (await worktreeSharer(db, recorded.dir, taskId)) return null;
      const open = await peekOpenMerge(recorded.dir);
      if (!open) return 'gone' as const;
      // A fetch may have moved a mutable ref (origin/<base>) since: the baseline names the commit.
      const baseline = recorded.fixBaseline;
      const fromBaseline =
        baseline !== null &&
        'mergeHead' in baseline &&
        baseline.mergeHead === open.mergeHead &&
        baseline.head === open.head;
      if (!fromBaseline && !(await mergeOpenFor(recorded.dir, recorded.ref))) return null;
      if (known.some((k) => k.dir === recorded.dir && k.mergeHead === open.mergeHead)) return null;
      const reported = { dir: recorded.dir, ref: recorded.ref, ...open };
      await tx.insert(schema.taskEvents).values({
        taskId,
        taskStepId: recorded.stepId,
        eventType: MERGE_LEFT_OPEN_EVENT,
        payload: reported,
      });
      return reported;
    });
    if (found === 'gone') await settleGoneMerge(db, taskId, recorded);
    else if (found) known.push({ ...found, settled: null, refused: null });
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

const movedReason = (putBack: boolean) =>
  `The merge the cancel left is no longer open in this directory (it was finished or aborted since); ${putBack ? 'Haive put its own project files back' : 'nothing was changed'}.`;

/** Abort the merge a cancelled task left open in `payload.dir`, on the person's confirmed click.
 *  The directory must name a report of this task still unsettled. Under the directory's lock it
 *  refuses while a live task holds the directory, and aborts only a merge whose HEAD and MERGE_HEAD
 *  are the reported ones: anything else changed since, and nothing is done. The outcome is the
 *  settled event; it throws only when no outcome could be recorded, so the job is retried. */
export async function abortLeftMerge(db: Database, payload: AbortLeftMergePayload): Promise<void> {
  const { taskId, dir, mergeHead } = payload;
  let changed = false;
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { status: true, repositoryId: true },
    });
    if (task?.status !== 'cancelled') return;
    const target = (await taskLeftOpen(db, taskId)).find(
      (m) => m.dir === dir && m.mergeHead === mergeHead && m.settled === null,
    );
    if (!target) return;
    const recorded = (await recordedMerges(db, taskId)).find((m) => m.dir === dir);
    const recordedBaseline = recorded?.fixBaseline ?? null;
    // An unrecordable baseline is passed on, so the leftovers report says the changes went unchecked.
    const baseline =
      recordedBaseline !== null &&
      ('unavailable' in recordedBaseline ||
        (recordedBaseline.head === target.head && recordedBaseline.mergeHead === target.mergeHead))
        ? recordedBaseline
        : null;
    const maskSource = await maskSourceOnce(db, taskId);

    const decision = await inMergeDirLock(db, dir, async (tx): Promise<AbortDecision> => {
      const [claim] = await tx
        .select()
        .from(schema.mergeDirClaims)
        .where(eq(schema.mergeDirClaims.mergeDir, dir))
        .for('update');
      const holder = claim ? await liveClaimHolder(tx, claim) : null;
      // A DAG level merge takes no dir claim, so a live task sharing the worktree is asked for too.
      const sharer = holder ?? (await worktreeSharer(db, dir, taskId));
      if (sharer) {
        return {
          outcome: 'refused',
          reason: `Task "${sharer.title}" (${sharer.id}) is working in this directory; abort once it finishes.`,
        };
      }
      const open = await peekOpenMerge(dir);
      if (!open || open.head !== target.head || open.mergeHead !== target.mergeHead) {
        // An earlier attempt may have aborted it and failed to report what it moved aside.
        const unreported = await relocateFixerChanges(
          dir,
          null,
          { taskId, runId: recorded?.fixInvocationId ?? randomUUID() },
          maskSource,
        );
        return { outcome: 'moved', reason: movedReason(false), leftovers: unreported };
      }
      const leftovers = baseline
        ? await relocateFixerChanges(
            dir,
            baseline,
            { taskId, runId: recorded?.fixInvocationId ?? randomUUID() },
            maskSource,
          )
        : null;
      if (leftovers?.indexHeld) {
        return {
          outcome: 'refused',
          reason: `A merge fixer staged changes outside the conflicted files, and they could not be taken back out of the index (${leftovers.indexHeld}), so the merge was left open to keep them; try again once the index is free.`,
          leftovers,
        };
      }
      const aborted = await abortMerge(dir);
      if (!aborted.ok) return { outcome: 'refused', reason: abortFailureNote(aborted), leftovers };
      changed = true;
      const unchecked =
        baseline !== null && 'tree' in baseline
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
    let putBack = false;
    if (
      task.repositoryId &&
      recorded?.state?.mode === 'same-branch' &&
      (decision.outcome === 'aborted' || decision.outcome === 'moved')
    ) {
      // A retry reads the merge as moved and the settle is idempotent, so a throw here is retried.
      changed = true;
      const save = saveByStepId(db, recorded.stepId);
      putBack = await settleProjections(db, task.repositoryId, recorded.state, save);
      // The kept owner and mode are only put back by a settle that finished: the report stays open.
      if (!putBack)
        throw new Error("Haive's project files were not re-synced yet; abort again to retry");
    }
    const reason = putBack && decision.outcome === 'moved' ? movedReason(true) : decision.reason;
    await settle(db, taskId, target, decision.outcome, reason);
  } catch (err) {
    logger.warn({ err, taskId, dir }, 'aborting the merge a cancel left open failed');
    // Once the merge is aborted a retry can only see it as moved: it reports what was moved aside
    // from the unreported manifest, so the job is retried rather than settled as refused.
    if (changed) throw err;
    const target = (await taskLeftOpen(db, taskId)).find(
      (m) => m.dir === dir && m.mergeHead === mergeHead && m.settled === null,
    );
    if (target) {
      await settle(
        db,
        taskId,
        target,
        'refused',
        `The abort failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Before a resolver clears a merge another (cancelled) task left open, that task's fixer changes
 *  outside the conflict are moved aside under its own report, as its own abort would have done.
 *  Returns why the clear must not go ahead: the index still holds what the fixer staged. */
export async function relocateLeftOpenFixers(
  db: Database,
  taskId: string,
  dir: string,
  open: OpenMerge,
): Promise<string | null> {
  for (const owner of await leftOpenOwners(db, taskId, dir, open)) {
    const merge = (await taskLeftOpen(db, owner.taskId)).find(
      (m) => m.dir === dir && m.mergeHead === open.mergeHead && m.settled === null,
    );
    if (!merge) continue;
    const recorded = (await recordedMerges(db, owner.taskId)).find((m) => m.dir === dir);
    const baseline = recorded?.fixBaseline ?? null;
    const usable =
      baseline !== null &&
      ('unavailable' in baseline ||
        (baseline.head === open.head && baseline.mergeHead === open.mergeHead));
    if (!recorded || !usable) continue;
    const leftovers = await relocateFixerChanges(
      dir,
      baseline,
      { taskId: owner.taskId, runId: recorded.fixInvocationId ?? randomUUID() },
      await maskSourceOnce(db, owner.taskId),
    );
    if (leftovers) {
      await recordFixerLeftovers(db, owner.taskId, recorded.stepId, merge.ref, leftovers);
    }
    if (leftovers?.indexHeld) {
      return `A merge the cancelled task "${owner.title}" (${owner.taskId}) left open here has fixer changes staged outside the conflict that could not be taken back out of the index (${leftovers.indexHeld}), so it was not cleared; abort it from that task once the index is free.`;
    }
  }
  return null;
}

async function leftOpenOwners(
  db: Database,
  taskId: string,
  dir: string,
  open: OpenMerge,
): Promise<{ taskId: string; title: string }[]> {
  return db
    .selectDistinct({ taskId: schema.taskEvents.taskId, title: schema.tasks.title })
    .from(schema.taskEvents)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskEvents.taskId))
    .where(
      and(
        eq(schema.taskEvents.eventType, MERGE_LEFT_OPEN_EVENT),
        ne(schema.taskEvents.taskId, taskId),
        sql`${schema.taskEvents.payload}->>'dir' = ${dir}`,
        sql`${schema.taskEvents.payload}->>'head' = ${open.head}`,
        sql`${schema.taskEvents.payload}->>'mergeHead' = ${open.mergeHead}`,
      ),
    );
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
  const owners = await leftOpenOwners(db, taskId, dir, before);
  let current = row;
  for (const owner of owners) {
    const merge = (await taskLeftOpen(db, owner.taskId)).find(
      (m) => m.dir === dir && m.mergeHead === before.mergeHead && m.settled === null,
    );
    if (!merge) continue;
    // The merge is already aborted, so a failure here must not fail this step: the report then
    // stays open, and the person's abort reads it as moved.
    const settled = await settle(
      db,
      owner.taskId,
      merge,
      'aborted-by-next',
      `Another task's merge needed the directory and cleared it first.`,
    ).then(
      () => true,
      (err: unknown) => {
        logger.warn({ err, taskId: owner.taskId, dir }, 'settling a left-open merge report failed');
        return false;
      },
    );
    if (!settled) continue;
    current = await addStepWarning(
      db,
      current,
      `A merge of ${merge.ref} that the cancelled task "${owner.title}" (${owner.taskId}) left open in ${dir} was aborted before this merge started.`,
    );
  }
  return current;
}

/** Gives `save` what the cancelled owners of `open` in `dir` kept, then takes it off them. */
export async function takeLeftOpenKept(
  db: Database,
  taskId: string,
  dir: string,
  open: OpenMerge,
  save: (kept: KeptMetadata) => Promise<void>,
): Promise<KeptMetadata> {
  const kept: KeptMetadata = {};
  const stepIds: string[] = [];
  for (const owner of await leftOpenOwners(db, taskId, dir, open)) {
    for (const { dir: mergeDir, state, stepId } of await recordedMerges(db, owner.taskId)) {
      if (mergeDir !== dir || state?.mode !== 'same-branch' || !state.keptMetadata) continue;
      Object.assign(kept, state.keptMetadata);
      stepIds.push(stepId);
    }
  }
  if (stepIds.length > 0) {
    await save(kept);
    await db
      .update(schema.taskSteps)
      .set({
        mergeResolveState: sql`${schema.taskSteps.mergeResolveState} - 'keptMetadata'`,
        updatedAt: new Date(),
      })
      .where(inArray(schema.taskSteps.id, stepIds));
  }
  return kept;
}
