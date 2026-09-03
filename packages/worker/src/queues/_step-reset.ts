import { and, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { schema, resetDagCurrentLevelForRetry, type Database } from '@haive/database';
import { computeFoldContribution } from '@haive/shared/timing';
import { isFatalProviderFailure } from './cli-exec/failure-class.js';

// Reset a step + its downstream back to `pending` so the worker re-runs the step from
// detect. Used by the `revise` route (handleResult): a review step asks to re-run an
// earlier generator (e.g. 03c reject → re-mine 03b). Mirrors the API retry reset
// (packages/api/src/routes/tasks/steps.ts) but lives worker-side so the queue can drive
// it without an HTTP round-trip. The two are intentional duplicates — keep them in sync.

/** Reset `targetStepId` and every non-pending downstream row (same round) to `pending`,
 *  superseding their open cli_invocations and dropping their agent minings. Deliberately
 *  does NOT touch task_events: append-only channels the target reads to revise (e.g. the
 *  biz-req rejection feedback) must survive the reset, exactly as across an API retry.
 *  Scoped to `round` so a concurrent fix-loop round's rows are never disturbed. Bumps the
 *  task's orchestration epoch (like the API retry) so stale advance-step jobs no-op.
 *  Returns the downstream-reset count + the new epoch, or null when no target row exists. */
export async function resetStepAndDownstream(
  db: Database,
  taskId: string,
  targetStepId: string,
  round: number,
): Promise<{ downstreamReset: number; newEpoch: number } | null> {
  const targetRows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, targetStepId),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  const target = targetRows[0];
  if (!target) return null;

  // Downstream by TRUE run order (run_seq = buildRunList position), NOT step_index —
  // a static per-workflow-type offset that is not run-monotonic once step families
  // interleave (env-replicate prelude in a workflow). Mirrors the API retry reset.
  // Fall back to step_index only for legacy rows with no run_seq.
  const targetSeq = target.runSeq;
  const downstream = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.round, round),
        targetSeq != null
          ? gt(schema.taskSteps.runSeq, targetSeq)
          : gt(schema.taskSteps.stepIndex, target.stepIndex),
      ),
    );
  const downstreamToReset = downstream.filter((r) => r.status !== 'pending').map((r) => r.id);
  const allStepIds = [target.id, ...downstreamToReset];

  let newEpoch = 0;
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(schema.cliInvocations)
      .set({ supersededAt: now })
      .where(
        and(
          inArray(schema.cliInvocations.taskStepId, allStepIds),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    await tx
      .delete(schema.taskStepAgentMinings)
      .where(inArray(schema.taskStepAgentMinings.taskStepId, allStepIds));
    // When this reset cascades through 06c-dag-execute, task_steps alone leaves the DAG's
    // task_dag_issues rows failed_unrecoverable, so resolveDagPhase re-derives the wedge and
    // the step re-halts with the identical error. Reset the current level's stuck issues too.
    // No-op when the task has no DAG / no stuck issue. Keep in sync with the API retry site.
    await resetDagCurrentLevelForRetry(tx, taskId);
    // Clearing formSchema is essential: the runner only re-renders the form when the
    // persisted schema is null. formValues is cleared so the regenerated form re-decides.
    // Zero the live timing per row, but first fold the finishing run's work/idle/user
    // into carried_* so the step's timing survives the restart (a plain reset would
    // discard the prior run, making the effort timer undercount). computeFoldContribution
    // counts a failed step's fail->retry dead-wait as idle so wall reconciles, and
    // reclassifies an orphaned still-open run's span as idle rather than inflating carried
    // work with it. Per-row (not a blanket update) because each row's contribution differs.
    const resetRows = [target, ...downstream.filter((r) => r.status !== 'pending')];
    for (const r of resetRows) {
      const c = computeFoldContribution(r, now.getTime());
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'pending',
          detectOutput: null,
          formSchema: null,
          formValues: null,
          output: null,
          iterations: [],
          iterationCount: 0,
          statusMessage: null,
          errorMessage: null,
          errorHint: null,
          startedAt: null,
          endedAt: null,
          idleMs: 0,
          waitingStartedAt: null,
          userActiveMs: 0,
          carriedWorkMs: r.carriedWorkMs + c.workMs,
          carriedIdleMs: r.carriedIdleMs + c.idleMs,
          carriedUserActiveMs: r.carriedUserActiveMs + c.userActiveMs,
          updatedAt: now,
        })
        .where(eq(schema.taskSteps.id, r.id));
    }
    // Bump the task's orchestration epoch so any advance-step job queued under the
    // prior epoch (a stale/duplicate job) is skipped by handleAdvanceStep — the
    // worker-side equivalent of the API retry's epoch bump.
    const bumped = await tx
      .update(schema.tasks)
      .set({ orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`, updatedAt: now })
      .where(eq(schema.tasks.id, taskId))
      .returning({ epoch: schema.tasks.orchestrationEpoch });
    newEpoch = bumped[0]?.epoch ?? 0;
  });

  return { downstreamReset: downstreamToReset.length, newEpoch };
}

/** Auto-resume a task that FAILED on a provider outage (session/rate-limit or 5xx), once the
 *  usage poller decides the provider is back (CONFIG_KEYS.ALLOWANCE_WATCH_MODE 'auto'). RESUME
 *  semantics — supersede only the step's failed blocking invocation and flip the step back to
 *  `running` WITHOUT clearing iterations/output, so a loop step (e.g. skill-generation)
 *  re-dispatches the failed pass and keeps every completed pass, and a FAN-OUT step keeps every
 *  terminal that finished while the ones the outage killed are marked for re-dispatch. Mirrors
 *  both arms of the API `resume` action (packages/api/src/routes/tasks/steps.ts) — keep them in
 *  sync — but runs worker-side and, unlike the manual resume, INCREMENTS the anti-thrash counter
 *  and stamps allowance_auto_resumed_at (the web notifier's distinct "auto-resumed" signal)
 *  instead of resetting the counter.
 *
 *  The task flip is guarded on `status='failed'`, so a concurrent MANUAL resume (which flips
 *  it to running first) wins and this no-ops → returns false and the caller skips the enqueue.
 *  Clears the allowance watch inline (mirror of the api CLEAR_ALLOWANCE_WATCH — the worker
 *  must not import @haive/api) plus the stale completedAt (else the UI wall clock stays frozen
 *  at failure time). Does NOT enqueue the advance itself (that would import the task queue and
 *  form a cycle) — the caller enqueues ADVANCE_STEP when this returns true. */
export async function autoResumeFailedStep(
  db: Database,
  args: { taskId: string; stepId: string; round: number; providerId: string | null; via: string },
): Promise<boolean> {
  const { taskId, stepId, round, providerId, via } = args;
  const stepRows = await db
    .select({ id: schema.taskSteps.id })
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, stepId),
        eq(schema.taskSteps.round, round),
      ),
    )
    .limit(1);
  const step = stepRows[0];
  if (!step) return false;

  let flipped = false;
  await db.transaction(async (tx) => {
    const now = new Date();
    // Guarded flip: only a task still `failed` is auto-resumed, so a concurrent manual resume
    // makes this a no-op. Clears the watch + stale completedAt, bumps the anti-thrash counter,
    // and stamps the auto-resumed marker — all atomically. RETURNING gives the post-increment
    // count for the event's `attempt`.
    const bumped = await tx
      .update(schema.tasks)
      .set({
        status: 'running',
        errorMessage: null,
        completedAt: null,
        awaitingAllowanceProviderId: null,
        awaitingProviderReason: null,
        awaitingProviderSince: null,
        allowanceResetAt: null,
        allowanceReplenishedAt: null,
        allowanceAutoResumeCount: sql`${schema.tasks.allowanceAutoResumeCount} + 1`,
        allowanceAutoResumedAt: now,
        updatedAt: now,
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'failed')))
      .returning({ count: schema.tasks.allowanceAutoResumeCount });
    if (bumped.length === 0) return; // already resumed elsewhere / not failed → no-op
    flipped = true;

    // Clear this step's own blocking invocation so resolveLlmPhase sees no live invocation and
    // re-dispatches a fresh wave at upcomingIteration = completed passes. The TRAILING
    // non-mining run, and only when it FAILED — mirror of the api's supersedeBlockingInvocation
    // (routes/tasks/steps.ts), keep the two in sync. Deliberately NOT a blanket sweep of every
    // open row: `agent_mining` invocations are never consumed (MEASURED: 0 of 321 on the dev
    // install), and the api filters `superseded_at IS NULL` in the per-step invocation panel and
    // in every cost/usage rollup, so a blanket supersede erases the terminals that already
    // SUCCEEDED — 109 of them on one armed plan_build — and their spend with them. It would also
    // discard a successful, unconsumed llm output on the two steps that own both an llm and a
    // fan-out (03-phase-0a-discovery, 09_5-skill-generation) and buy a fresh CLI call for it.
    const blockerRows = await tx
      .select({
        id: schema.cliInvocations.id,
        endedAt: schema.cliInvocations.endedAt,
        exitCode: schema.cliInvocations.exitCode,
        errorMessage: schema.cliInvocations.errorMessage,
      })
      .from(schema.cliInvocations)
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, step.id),
          isNull(schema.cliInvocations.supersededAt),
          isNull(schema.cliInvocations.consumedAt),
          ne(schema.cliInvocations.mode, 'agent_mining'),
        ),
      )
      .orderBy(desc(schema.cliInvocations.createdAt))
      .limit(1);
    const blocker = blockerRows[0];
    // A non-zero exit, a null exit (killed / orphaned), or any error text — the same three the
    // llm resolver treats as a failed invocation.
    if (
      blocker &&
      blocker.endedAt != null &&
      (blocker.exitCode == null ||
        blocker.exitCode !== 0 ||
        (blocker.errorMessage?.trim().length ?? 0) > 0)
    ) {
      await tx
        .update(schema.cliInvocations)
        .set({ supersededAt: now })
        .where(eq(schema.cliInvocations.id, blocker.id));
    }

    // Fan-out arm: mark the terminals the outage killed for re-dispatch, keeping every `done`
    // row. Same marker the human's Resume writes, read by the fan-out barrier's user-requested
    // arm (step-runner.ts) — the ONLY route to a partial re-dispatch, since the barrier returns
    // early once any mining row exists and so never re-runs selectAgents. Without it the barrier
    // walks on to its fatal-provider guard, reads the SAME stored rate-limit text off the failed
    // rows and re-fails the step within a second, on every attempt, until the cap gives up.
    //
    // Scoped to that guard's own predicate rather than to every failed row (what the human's
    // Resume marks): a machine must not spend the recovered quota on agents that died of
    // something else, and clearing exactly the set the guard scans is what lets the step get
    // past it — the remaining failures then degrade through apply() as they normally would.
    // MEASURED on one armed plan_build: 8 of its 47 failed rows were the rate limit; the other
    // 39 were an oversized prompt or a config permission error and would fail again identically.
    const failedAgents = await tx
      .select({
        id: schema.taskStepAgentMinings.id,
        errorMessage: schema.taskStepAgentMinings.errorMessage,
      })
      .from(schema.taskStepAgentMinings)
      .where(
        and(
          eq(schema.taskStepAgentMinings.taskStepId, step.id),
          eq(schema.taskStepAgentMinings.status, 'failed'),
        ),
      );
    const outageAgents = failedAgents.filter((a) => isFatalProviderFailure(a.errorMessage));
    if (outageAgents.length > 0) {
      await tx
        .update(schema.taskStepAgentMinings)
        .set({ userRetryRequestedAt: now, updatedAt: now })
        .where(
          inArray(
            schema.taskStepAgentMinings.id,
            outageAgents.map((a) => a.id),
          ),
        );
    }
    // Preserve iterations/output/detect/form so the loop resumes at the failed pass.
    await tx
      .update(schema.taskSteps)
      .set({
        status: 'running',
        errorMessage: null,
        errorHint: null,
        endedAt: null,
        statusMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    await tx.insert(schema.taskEvents).values({
      taskId,
      taskStepId: step.id,
      eventType: 'task.auto_resumed',
      payload: { stepId, round, providerId, via, attempt: bumped[0]?.count ?? null },
    });
  });
  return flipped;
}
