import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema, resetDagCurrentLevelForRetry, type Database } from '@haive/database';
import { computeFoldContribution } from '@haive/shared/timing';

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
 *  semantics — supersede only the failed pass's live invocation and flip the step back to
 *  `running` WITHOUT clearing iterations/output, so a loop step (e.g. skill-generation)
 *  re-dispatches the failed pass and keeps every completed pass. Mirrors the API `resume`
 *  action (packages/api/src/routes/tasks/steps.ts) — keep them in sync — but runs worker-side
 *  and, unlike the manual resume, INCREMENTS the anti-thrash counter and stamps
 *  allowance_auto_resumed_at (the web notifier's distinct "auto-resumed" signal) instead of
 *  resetting the counter.
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

    // Supersede the failed pass's live invocation so resolveLlmPhase sees no live invocation
    // and re-dispatches a fresh wave at upcomingIteration = completed passes.
    await tx
      .update(schema.cliInvocations)
      .set({ supersededAt: now })
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, step.id),
          isNull(schema.cliInvocations.supersededAt),
          isNull(schema.cliInvocations.consumedAt),
        ),
      );
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
