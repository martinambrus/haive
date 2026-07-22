import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import * as schema from './schema/index.js';
import type { Database } from './index.js';

// Transaction handle type (the callback arg of Database.transaction), so both retry
// reset sites can run this inside their existing transaction and keep the whole reset
// atomic. A full Database is also assignable, so callers may pass either.
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/** An issue is a stuck-failed state a retry should re-attempt iff review/escalation gave
 *  up on it (`resolution = 'failed_unrecoverable'`, whatever its outcome — a review-failed
 *  issue codes fine but is blocked), OR the coder failed before any resolution was recorded
 *  (`outcome = 'failed_unrecoverable'` with no resolution yet). Every DELIBERATE terminal
 *  resolution is thereby left alone: re-running a `split` parent would re-dispatch a coder
 *  for an issue already superseded by its child sub-issues, and an `approved` /
 *  `completed_with_debt` / `skipped` issue is done. */
const isStuckFailed = or(
  eq(schema.taskDagIssues.resolution, 'failed_unrecoverable'),
  and(
    eq(schema.taskDagIssues.outcome, 'failed_unrecoverable'),
    isNull(schema.taskDagIssues.resolution),
  ),
);

/**
 * DAG-aware half of a 06c-dag-execute Retry. Both reset sites (the API retry handler and
 * the worker `resetStepAndDownstream`) reset `task_steps` and supersede `cli_invocations`
 * but leave `task_dag_issues` untouched, so `resolveDagPhase` re-derives the SAME failed
 * state on re-run and the step re-wedges with the identical "DAG ... failure" error. This
 * resets the current (lowest non-checkpointed) level's UNRECOVERABLE issues back to
 * `pending` so step (B) re-dispatches them from a clean slate.
 *
 * Scope is deliberately narrow:
 *  - only the current level — checkpointed levels keep their merged work (a full "redo the
 *    whole DAG" is explicitly out of scope);
 *  - only issues that are `failed_unrecoverable` (by outcome, i.e. the coder failed, or by
 *    resolution, i.e. review/escalation gave up) with no deliberate terminal resolution —
 *    a `split` parent, an accepted-with-debt issue, a skipped issue and a merged issue are
 *    all left as-is;
 *  - the reset clears the transient re-dispatch budget (`infraRetries`) and every review /
 *    escalation / merge field so the re-attempt starts fresh, but KEEPS the worktree
 *    (path/branch) to reuse it, mirroring the in-executor transient re-dispatch;
 *  - it DELETES the reset issues' `dag_agent_runs`: a stale CONSUMED reviewer run makes
 *    `resolveReviewPhase` skip the re-attempted issue without spawning a fresh reviewer
 *    (dag-executor "latest.consumedAt -> continue"), which would silently wedge review;
 *  - it clears the current level's transient `mergeState` (active conflict / in-flight fix
 *    invocation / conflict-retry counters) so the level re-reaches merge with clean state.
 *    Durable per-issue merge status lives on the (preserved) merged issues.
 *
 * `cli_invocations` are intentionally NOT touched here — every DAG invocation is linked to
 * the 06c `task_steps` row via `taskStepId`, so the caller's existing invocation-supersede
 * already covers the killed/orphaned coders.
 *
 * A no-op (returns 0) when the task has no DAG plan, all levels are checkpointed, or the
 * current level has no resettable issue — so both call sites may invoke it unconditionally;
 * it only ever acts on a genuinely wedged (or in-cascade) DAG.
 *
 * Pass the caller's transaction handle so the whole retry is one atomic unit. Returns the
 * number of issues reset.
 */
export async function resetDagCurrentLevelForRetry(tx: DbHandle, taskId: string): Promise<number> {
  const plan = await tx.query.taskDagPlans.findFirst({
    where: eq(schema.taskDagPlans.taskId, taskId),
    columns: { id: true },
  });
  if (!plan) return 0; // not a DAG task

  // Current level = the lowest level not yet checkpointed (mirrors resolveDagPhase's
  // `levels.find(l => l.checkpointedAt === null)` over an asc-ordered scan).
  const levelRows = await tx
    .select({ id: schema.taskDagLevels.id, level: schema.taskDagLevels.level })
    .from(schema.taskDagLevels)
    .where(
      and(eq(schema.taskDagLevels.dagPlanId, plan.id), isNull(schema.taskDagLevels.checkpointedAt)),
    )
    .orderBy(schema.taskDagLevels.level)
    .limit(1);
  const curLevel = levelRows[0];
  if (!curLevel) return 0; // all levels checkpointed → nothing to re-run

  const stuck = await tx
    .select({ id: schema.taskDagIssues.id })
    .from(schema.taskDagIssues)
    .where(
      and(
        eq(schema.taskDagIssues.dagPlanId, plan.id),
        eq(schema.taskDagIssues.level, curLevel.level),
        isStuckFailed,
      ),
    );
  const ids = stuck.map((r) => r.id);
  if (ids.length === 0) return 0;

  const now = new Date();
  await tx
    .update(schema.taskDagIssues)
    .set({
      outcome: 'pending',
      cliInvocationId: null,
      infraRetries: 0,
      resolution: null,
      reviewStatus: null,
      innerIteration: 0,
      stuckCount: 0,
      reviewerVerdict: null,
      advisorInvocations: 0,
      lastAdvisorAction: null,
      retryContext: null,
      filesModified: [],
      debtItems: [],
      concerns: null,
      rawOutput: null,
      errorMessage: null,
      mergeStatus: null,
      mergedAt: null,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
    })
    .where(inArray(schema.taskDagIssues.id, ids));

  // Drop per-attempt agent history for the reset issues (see doc comment: a stale
  // consumed reviewer run would wedge the fresh review).
  await tx.delete(schema.dagAgentRuns).where(inArray(schema.dagAgentRuns.dagIssueId, ids));

  // Clear the current level's transient merge cursor so a later re-merge starts clean.
  await tx
    .update(schema.taskDagLevels)
    .set({ phase: 'pending', mergeState: null, updatedAt: now })
    .where(eq(schema.taskDagLevels.id, curLevel.id));

  return ids.length;
}
