import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { schema, resetDagCurrentLevelForRetry, type Database } from '@haive/database';
import { computeFoldContribution } from '@haive/shared/timing';
import {
  CLI_PROVIDER_CATALOG,
  clarifyStepRequestSchema,
  logger,
  MERGE_CLARIFICATION_ANSWERED_EVENT,
  setCliProviderRequestSchema,
  stepActionRequestSchema,
  STEP_CLI_ROLES,
  submitStepRequestSchema,
  TASK_JOB_NAMES,
  type CliProviderName,
  type TaskJobPayload,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';
import { killTaskSandboxes } from '../../lib/sandbox-kill.js';
import { cancelTaskRow, enqueueCancelJob, CLEAR_ALLOWANCE_WATCH } from '../../lib/cancel-task.js';
import { getTaskQueue } from '../../queues.js';
import {
  appendTaskEvent,
  CLI_DISPATCH_STEP_ID_SET,
  enrichStepsWithActiveRole,
  enrichStepsWithAgentCounts,
  enrichStepsWithCliStats,
  enrichStepsWithCliPreferences,
  enrichStepsWithSkipFlag,
  isStepSkippable,
  propagateModelHealthCliToTaskDefault,
} from './_helpers.js';

/** Credit the time a CLOSED step spent closed to `idle_ms`, for the actions that RE-OPEN one.
 *
 *  Resume and retry_ai null `ended_at` but deliberately keep `started_at` — the step continues
 *  its existing run rather than starting a fresh one. That extends its span backwards across the
 *  period between the close and the click, and `computeStepContribution` bills a step's span
 *  minus its idle as WORK, so without this the whole gap silently becomes agent work. Observed:
 *  a step Stopped 2026-08-14 12:06 and resumed 2026-08-16 18:25 reported 55.27h of work for
 *  57min of real CLI runtime.
 *
 *  `ended_at` is the anchor because the closing path itself wrote it — stopActiveCliInvocations
 *  (routes/tasks/index.ts) stamps it while folding any live park marker, so this is the exact
 *  mirror of that fold on the way back in. Applied in the SAME update that clears `ended_at`:
 *  split across two statements there is a window where the anchor is already gone, which is the
 *  same reason cancelTaskRow folds in one statement.
 *
 *  `greatest(0, NULL)` is 0 in Postgres, so re-opening a step that is still LIVE (`ended_at`
 *  null) credits nothing and needs no extra guard. The int4 clamp is load-bearing rather than
 *  hardening: `idle_ms` is `integer` (~24.8 days), and a task resumed a month after being
 *  stopped would otherwise raise "integer out of range" and abort the resume outright.
 *
 *  NOT for the reset-style actions (retry, switch-cli): those null `started_at` too and fold the
 *  finishing run into `carried_*` via computeFoldContribution, so they have no span to extend
 *  and adding this would double-count. */
const CLOSED_GAP_INTO_IDLE_MS = sql`${schema.taskSteps.idleMs} + least(2147483647 - ${schema.taskSteps.idleMs},
  greatest(0, floor(extract(epoch from (now() - ${schema.taskSteps.endedAt})) * 1000)))::int`;

/** Validate a requested per-step effort against the resolved provider's effortScale.
 *  Returns the level only when the CLI has an effort knob and the value is in-scale;
 *  otherwise null (so a knob-less CLI, or a stale level such as claude 'max' on codex,
 *  is simply not stored). */
function clampEffort(name: CliProviderName, level: string | null | undefined): string | null {
  if (!level) return null;
  const scale = CLI_PROVIDER_CATALOG[name].effortScale;
  return scale && scale.values.includes(level) ? level : null;
}

/** Transaction handle (the callback arg of Database.transaction). A full Database is also
 *  assignable, so callers may pass either. Mirrors the same alias in @haive/database. */
type DbHandle = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Blank a set of step rows so the worker re-runs them from detect: supersede their live
 *  invocations, drop their agent minings, clear the wedged DAG level, and zero each row's
 *  live state after folding its finishing run into carried_*.
 *
 *  Shared by the two callers that mean different things by "the set": Retry passes the clicked
 *  step PLUS its downstream, while the resume mining arm passes the downstream ONLY — there the
 *  clicked step deliberately keeps its detect/form output and its surviving agents' rows.
 *  Extracted so those two can never disagree about what a re-run resets. (The worker's
 *  resetStepAndDownstream is a third, deliberate copy; keep it in sync.)
 *
 *  Callers pass only rows worth resetting — a row already `pending` has nothing to blank.
 *
 *  Clearing formSchema is essential: step-runner only re-renders the form when the persisted
 *  schema is null, so without this a re-run would re-run the LLM against a stale schema.
 *  formValues is cleared so the user re-confirms inputs against the regenerated schema.
 *  computeFoldContribution counts a failed step's fail->retry wait as idle so wall-clock
 *  reconciles, and reclassifies an orphaned still-open run's span as idle rather than inflating
 *  carried work — per row, because each contributes differently. */
async function resetRowsForRerun(
  tx: DbHandle,
  taskId: string,
  rows: (typeof schema.taskSteps.$inferSelect)[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  await tx
    .update(schema.cliInvocations)
    .set({ supersededAt: now })
    .where(
      and(
        inArray(schema.cliInvocations.taskStepId, ids),
        isNull(schema.cliInvocations.supersededAt),
      ),
    );
  await tx
    .delete(schema.taskStepAgentMinings)
    .where(inArray(schema.taskStepAgentMinings.taskStepId, ids));
  // Re-running 06c-dag-execute (or any step whose set includes it) must also clear the wedged
  // DAG level: resetting task_steps alone leaves task_dag_issues failed_unrecoverable, so
  // resolveDagPhase re-derives the same failure and the step re-halts identically. No-op when
  // the task has no DAG / no stuck issue.
  await resetDagCurrentLevelForRetry(tx, taskId);
  for (const r of rows) {
    const contrib = computeFoldContribution(r, now.getTime());
    await tx
      .update(schema.taskSteps)
      .set({
        status: 'pending',
        detectOutput: null,
        formSchema: null,
        formValues: null,
        output: null,
        // Loop state must reset too. A stale iterationCount/iterations makes a re-run loop
        // step (e.g. spec quality) resume at the old count — past its budget — and carry the
        // prior passes forward instead of starting a clean loop.
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
        carriedWorkMs: r.carriedWorkMs + contrib.workMs,
        carriedIdleMs: r.carriedIdleMs + contrib.idleMs,
        carriedUserActiveMs: r.carriedUserActiveMs + contrib.userActiveMs,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, r.id));
  }
}

/** Supersede the step's trailing FAILED non-mining invocation, if it has one, and answer which.
 *
 *  The fan-out arm of `resume` marks the dead terminals and hands back to the worker — but
 *  `resolveLlmPhase` runs BEFORE `resolveAgentMiningPhase`, so a trailing failed invocation fails
 *  the step on the very next advance and the marker is never read. Observed on task 977e1c5a:
 *  "Re-run 5 failed terminals" wrote `step.resume` and `step.failed` 0.5s apart, twice, with
 *  `user_retry_requested_at` still set on all five mining rows afterwards. The loop arm supersedes
 *  its failed pass for the same reason; the fan-out arm returns long before reaching that code.
 *
 *  Narrower than the loop arm's blanket supersede on purpose. This arm can target a DEGRADED
 *  (`done`) step whose trailing invocation SUCCEEDED and is not yet consumed, and superseding that
 *  would throw away good output and buy a fresh CLI call for nothing. `agent_mining` rows are
 *  excluded for the same reason — the fan-out's results live on `task_step_agent_minings`, which
 *  `retryMiningAgents` reads `cli_invocation_id` off, and `resolveLlmPhase` never reads them
 *  either. Filters and failure test mirror that resolver exactly, so the two cannot disagree
 *  about which row is the blocker. */
export async function supersedeBlockingInvocation(
  tx: DbHandle,
  taskStepId: string,
  now: Date,
): Promise<string | null> {
  const rows = await tx
    .select({
      id: schema.cliInvocations.id,
      endedAt: schema.cliInvocations.endedAt,
      exitCode: schema.cliInvocations.exitCode,
      errorMessage: schema.cliInvocations.errorMessage,
    })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, taskStepId),
        isNull(schema.cliInvocations.supersededAt),
        isNull(schema.cliInvocations.consumedAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  const blocker = rows[0];
  if (!blocker || blocker.endedAt == null) return null;
  // A non-zero exit, a null exit (killed / orphaned), or any error text (a stream that ended
  // without a result) — the same three the resolver treats as a failed invocation.
  const failed =
    blocker.exitCode == null ||
    blocker.exitCode !== 0 ||
    (blocker.errorMessage?.trim().length ?? 0) > 0;
  if (!failed) return null;
  await tx
    .update(schema.cliInvocations)
    .set({ supersededAt: now })
    .where(eq(schema.cliInvocations.id, blocker.id));
  return blocker.id;
}

export const stepRoutes = new Hono<AppEnv>();

stepRoutes.get('/:id/steps', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true, ignoreSavedStepClis: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, id))
    // Run-list order — kept identical to GET /tasks/:id (index.ts). run_seq is the
    // step's position in buildRunList (worker-stamped), monotonic with true run order
    // even for steps reused across task types or inserted mid-pipeline on a resumed task
    // — cases where createdAt (created out of run order) and stepIndex alone (global
    // offset, not run-monotonic for reused steps) both misorder. round is primary so a
    // fix loop's round-N rows (same step, higher round) stay grouped after round 0.
    // Legacy rows with null run_seq fall back to createdAt (Postgres sorts NULLs last).
    .orderBy(
      asc(schema.taskSteps.round),
      asc(schema.taskSteps.runSeq),
      asc(schema.taskSteps.createdAt),
      asc(schema.taskSteps.stepIndex),
    );
  const enriched = await enrichStepsWithCliPreferences(
    db,
    userId,
    stepRows,
    id,
    task.ignoreSavedStepClis,
  );
  const withSkip = await enrichStepsWithSkipFlag(db, id, enriched);
  const withStats = await enrichStepsWithCliStats(db, id, withSkip);
  const withActiveRole = await enrichStepsWithActiveRole(db, id, withStats);
  const steps = await enrichStepsWithAgentCounts(db, id, withActiveRole);
  return c.json({ steps });
});

// RAG query telemetry for a step: the rag_search calls made during the step's
// run window (attributed by created_at — the rag token is task-scoped, not
// step-scoped). Drives the "Show RAG stats" panel on the discovery step card.
stepRoutes.get('/:id/steps/:stepId/rag-queries', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  const step = await db.query.taskSteps.findFirst({
    where: and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.stepId, stepId)),
    columns: { startedAt: true, endedAt: true },
  });
  if (!step?.startedAt) return c.json({ queries: [] });
  const end = step.endedAt ?? new Date();

  const queries = await db
    .select({
      id: schema.ragQueryLog.id,
      query: schema.ragQueryLog.query,
      topK: schema.ragQueryLog.topK,
      hitCount: schema.ragQueryLog.hitCount,
      kbHits: schema.ragQueryLog.kbHits,
      codeHits: schema.ragQueryLog.codeHits,
      runbookHits: schema.ragQueryLog.runbookHits,
      learningHits: schema.ragQueryLog.learningHits,
      maxRrf: schema.ragQueryLog.maxRrf,
      maxDense: schema.ragQueryLog.maxDense,
      createdAt: schema.ragQueryLog.createdAt,
    })
    .from(schema.ragQueryLog)
    .where(
      and(
        eq(schema.ragQueryLog.taskId, id),
        gte(schema.ragQueryLog.createdAt, step.startedAt),
        lte(schema.ragQueryLog.createdAt, end),
      ),
    )
    .orderBy(asc(schema.ragQueryLog.createdAt));

  return c.json({ queries });
});

// Increment a step's user-active time. The browser measures the focused-and-
// visible time the user spends while the step waits for input (waiting_form)
// and posts it here in small increments. deltaMs is clamped per request to
// bound clock jumps / abuse (the client flushes roughly every 10s). No status
// guard: a flush can legitimately land just after the step leaves waiting_form.
const userActiveRequestSchema = z.object({
  deltaMs: z.number().int().min(0).max(60_000),
});

stepRoutes.post('/:id/steps/:stepRowId/user-active', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  // The step ROW id (unique per fix-loop round), NOT the stepId — a stepId maps to
  // one row per round, so updating by stepId would add the time onto every round and
  // double-count it in the task total.
  const stepRowId = c.req.param('stepRowId');
  const { deltaMs } = userActiveRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  if (deltaMs > 0) {
    await db
      .update(schema.taskSteps)
      .set({
        userActiveMs: sql`${schema.taskSteps.userActiveMs} + ${deltaMs}`,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.taskSteps.id, stepRowId), eq(schema.taskSteps.taskId, id)));
  }

  return c.json({ ok: true });
});

stepRoutes.post('/:id/steps/:stepId/submit', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const body = submitStepRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  // Target the row awaiting submission: filter to waiting_form + the latest round, so a
  // round > 0 parked form (a fix-loop escalation gate or a manual-mode fix round) is
  // submitted, not the original round-0 row of the same stepId (which is already done).
  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, id),
        eq(schema.taskSteps.stepId, stepId),
        eq(schema.taskSteps.status, 'waiting_form'),
      ),
    )
    .orderBy(desc(schema.taskSteps.round))
    .limit(1);
  const step = stepRows[0];
  if (!step) throw new HttpError(409, `No step awaiting form submission for id ${stepId}`);

  const now = new Date();
  // Close the idle (waiting-for-input) period: fold the time since the step
  // entered waiting_form into idle_ms so the active-work timer excludes it.
  const closedIdleMs = step.waitingStartedAt
    ? Math.max(0, now.getTime() - step.waitingStartedAt.getTime())
    : 0;
  await db
    .update(schema.taskSteps)
    .set({
      formValues: body.values,
      idleMs: step.idleMs + closedIdleMs,
      waitingStartedAt: null,
      updatedAt: now,
    })
    .where(eq(schema.taskSteps.id, step.id));

  await appendTaskEvent(db, id, step.id, 'step.form_submitted', {
    stepId,
    fieldCount: Object.keys(body.values).length,
  });

  const queue = getTaskQueue();
  const payload: TaskJobPayload = {
    taskId: id,
    userId,
    stepId,
    round: step.round,
    formValues: body.values,
  };
  await queue.add(TASK_JOB_NAMES.ADVANCE_STEP, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ ok: true, queued: true });
});

// Mid-step clarification answer (e.g. the merge-resolver asking how to resolve a
// conflict). Unlike /submit it must NOT overwrite form_values — the answer rides
// task_events; the worker reads the latest outstanding guidance on re-entry.
stepRoutes.post('/:id/steps/:stepId/clarify', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const body = clarifyStepRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, id),
        eq(schema.taskSteps.stepId, stepId),
        eq(schema.taskSteps.status, 'waiting_form'),
      ),
    )
    .orderBy(desc(schema.taskSteps.round))
    .limit(1);
  const step = stepRows[0];
  if (!step) throw new HttpError(409, `No step awaiting clarification for id ${stepId}`);

  const now = new Date();
  const closedIdleMs = step.waitingStartedAt
    ? Math.max(0, now.getTime() - step.waitingStartedAt.getTime())
    : 0;
  // Persist the answer to task_events (NOT form_values) and close the idle period.
  await db.insert(schema.taskEvents).values({
    taskId: id,
    taskStepId: step.id,
    eventType: MERGE_CLARIFICATION_ANSWERED_EVENT,
    payload: { answer: body.answer },
  });
  await db
    .update(schema.taskSteps)
    .set({ idleMs: step.idleMs + closedIdleMs, waitingStartedAt: null, updatedAt: now })
    .where(eq(schema.taskSteps.id, step.id));

  await appendTaskEvent(db, id, step.id, 'step.clarified', { stepId });

  const queue = getTaskQueue();
  const payload: TaskJobPayload = { taskId: id, userId, stepId, round: step.round };
  await queue.add(TASK_JOB_NAMES.ADVANCE_STEP, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ ok: true, queued: true });
});

stepRoutes.post('/:id/steps/:stepId/action', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const body = stepActionRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');

  // Act on the round the caller named. A fix-loop step recurs once per round
  // (round 0 = original pass), each rendered as its own row with its own
  // buttons, so the UI says which row's button was clicked. Fall back to the
  // latest round when unspecified. Without this, the query grabbed an arbitrary
  // (round-0) row, so Retry/Stop on a looped step reset the wrong round.
  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(
      and(
        eq(schema.taskSteps.taskId, id),
        eq(schema.taskSteps.stepId, stepId),
        body.round !== undefined ? eq(schema.taskSteps.round, body.round) : undefined,
      ),
    )
    .orderBy(desc(schema.taskSteps.round))
    .limit(1);
  const step = stepRows[0];
  if (!step) throw new HttpError(404, 'Step not found');

  if (body.action === 'retry') {
    // Retry resets a step (and its downstream) back to pending so the worker
    // can re-run it. Any status is retryable — including `running` and
    // `waiting_cli` on this step or any downstream. When a step in the
    // cascade is in-flight we force-kill its sandbox containers (steps run
    // sequentially within a task, so all `haive.task.id`-labelled containers
    // belong to the active step). The killed CLI process exits with non-zero
    // and the cli_invocations rows are about to be marked superseded anyway.
    // Downstream = steps that run AFTER this one in TRUE run order. run_seq (the
    // buildRunList position — the same key the task-detail endpoint sorts by) is
    // run-monotonic; step_index is a static per-workflow-type offset that is NOT
    // run-monotonic once step families interleave (env-replicate prelude spliced into a
    // workflow, run_app env steps). Keying downstream on step_index reset the wrong set
    // (missed earlier-running reused steps; swept genuinely-earlier ones). Fall back to
    // step_index only for legacy rows with no run_seq.
    // Scoped to the clicked card's ROUND, mirroring resetStepAndDownstream in the worker (the
    // two are intentional duplicates). Without the round predicate this swept every round: a
    // retry of 07b at round 7 also blanked the round 0-6 rows of every later step — their
    // output, form values and agent-mining rows deleted — even though the forward walk only
    // ever runs the current round's rows. Those earlier rows are settled history the task page
    // renders as its own cards, and a step's mining rows are the per-agent timeout history a
    // later round reads. Rows the walk has yet to materialise at this round simply do not exist
    // yet; upsertRow creates them pending when it reaches them, so nothing is left unreset.
    const targetSeq = step.runSeq;
    const downstream = await db
      .select()
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, id),
          eq(schema.taskSteps.round, step.round),
          targetSeq != null
            ? gt(schema.taskSteps.runSeq, targetSeq)
            : gt(schema.taskSteps.stepIndex, step.stepIndex),
        ),
      );

    const cascadeIsActive =
      step.status === 'running' ||
      step.status === 'waiting_cli' ||
      downstream.some((r) => r.status === 'running' || r.status === 'waiting_cli');
    if (cascadeIsActive) {
      const killed = await killTaskSandboxes(id);
      logger.info({ taskId: id, stepId, killed }, 'killed task sandboxes for retry-while-active');
    }

    let newEpoch = 0;
    await db.transaction(async (tx) => {
      const now = new Date();
      const downstreamToReset = downstream.filter((r) => r.status !== 'pending');
      // Retry resets the clicked step AND its downstream; see resetRowsForRerun for what a
      // reset blanks and why. Mirrors resetStepAndDownstream in the worker.
      await resetRowsForRerun(tx, id, [step, ...downstreamToReset], now);
      // Per-step "Override and run": only the clicked step bypasses the
      // unsafe-for-local-models guard on re-run. A plain retry sets this false
      // (re-arming the guard); the override button sets it true. Scoped to
      // step.id so the downstream cascade keeps its own override state.
      // pauseFormOnRetry: a plain Retry makes the clicked step STOP at its form
      // even under auto-continue, so the user can edit a form that would otherwise
      // auto-submit. "Override and run" is an explicit run-it-now, so it does NOT
      // pause (hence `!== true`). One-shot — step-runner clears it on park. Scoped
      // to step.id like the override; the downstream cascade keeps auto-continuing.
      // cliTimeoutOverrideMs: "Retry with longer timeout" pins this step's CLI budget
      // to the minutes the user picked; every other retry path writes null, so the
      // escalating ladder applies again and no stale override outlives the run that
      // needed it. Same scoping as the two above.
      //
      // cliTimeoutLearnedMs: the same number is also EVIDENCE about this step, and evidence
      // must outlive the row. The pin alone died at the next round fork (upsertRow INSERTs a
      // fresh row), so a 120-minute choice at round 6 was back to the base budget at round 7.
      // Raise the high-water mark here and later rounds start from it. Omitted rather than
      // nulled on a plain retry: clearing the pin does not un-learn what the CLI did.
      const pinnedTimeoutMs = body.timeoutMinutes ? body.timeoutMinutes * 60_000 : null;
      await tx
        .update(schema.taskSteps)
        .set({
          localModelOverride: body.overrideLocalModel === true,
          pauseFormOnRetry: body.overrideLocalModel !== true,
          cliTimeoutOverrideMs: pinnedTimeoutMs,
          ...(pinnedTimeoutMs
            ? {
                cliTimeoutLearnedMs: sql`greatest(coalesce(${schema.taskSteps.cliTimeoutLearnedMs}, 0), ${pinnedTimeoutMs})`,
              }
            : {}),
        })
        .where(eq(schema.taskSteps.id, step.id));
      const bumped = await tx
        .update(schema.tasks)
        .set({
          status: 'running',
          errorMessage: null,
          completedAt: null,
          allowanceAutoResumeCount: 0,
          currentStepId: stepId,
          // run_seq (run-monotonic order), not step_index — mirrors the worker's
          // resolveCurrentStepIndex so the "Step index" label reflects true run order.
          currentStepIndex: step.runSeq ?? step.stepIndex,
          // Bump the orchestration epoch so any advance-step job still queued from
          // before this retry is skipped as stale (a retry stops in-flight work first).
          orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
          ...CLEAR_ALLOWANCE_WATCH,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id))
        .returning({ epoch: schema.tasks.orchestrationEpoch });
      newEpoch = bumped[0]?.epoch ?? 0;
      await tx.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: step.id,
        eventType: 'step.retry',
        payload: {
          stepId,
          note: body.note ?? null,
          priorStatus: step.status,
          cascadedSteps: downstreamToReset.length,
          overrideLocalModel: body.overrideLocalModel === true,
          timeoutMinutes: body.timeoutMinutes ?? null,
        },
      });
    });
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      // round is essential: handleAdvanceStep defaults a missing round to 0, so it
      // would resolve the round-0 (done) sibling of a fix-loop step and advance PAST
      // the pending retried round instead of re-running it (round-drop, cf. 1408fc9).
      { taskId: id, userId, stepId, round: step.round, epoch: newEpoch } as TaskJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return c.json({ ok: true, status: 'pending' });
  }

  if (body.action === 'resume') {
    // Resume a multi-iteration loop step from the pass that FAILED, keeping every
    // completed pass (unlike retry, which resets to pass 0). The user picks a
    // different CLI first (e.g. when one runs out of credits); resume re-dispatches
    // the failed pass with the now-selected provider. Only for a loop step that has
    // already completed ≥1 pass — otherwise there is nothing to preserve, use retry.
    // Resume is for loop steps: one that already completed ≥1 pass, OR a loop
    // step that failed on its very first pass (e.g. the CLI ran out of credits
    // before any pass finished). The latter has iterationCount 0 but is still
    // resumable — supersede the failed invocation and re-dispatch pass 0 with the
    // newly-picked CLI. A non-loop step (no cliRoles) at iterationCount 0 has
    // nothing to preserve — use Retry.
    // Fan-out arm, checked BEFORE the loop gate below. A step whose CONCURRENT agent terminals
    // (08c runs a peer reviewer, a security reviewer and extra lenses side by side) include at
    // least one failed row. Resume's promise — keep what finished, redo what did not — was only
    // ever built for SEQUENTIAL passes, so every fan-out step fell through to the 409 below and
    // the sole recovery was Retry, which deletes every agent row and re-buys the reviewers that
    // had already succeeded.
    //
    // The re-dispatch itself is the worker's job: partial re-dispatch is reachable ONLY through
    // retryMiningAgents, because the fan-out barrier returns early whenever any mining row
    // exists and so never re-runs selectAgents. This marks the failed rows and hands over.
    // Deleting them instead would be worse than doing nothing — miningOutcome would then report
    // `absent`, which 08c reads as "this lens was never asked for" and silently approves.
    //
    // Refused while the fan-out is still in progress, BEFORE anything is written or killed. A
    // resume here is not "redo what died": `liveInCascade` below reads this step's own
    // `waiting_cli` and calls killTaskSandboxes, which destroys the sandboxes of the siblings
    // that are still working — and only the flagged rows are re-dispatched, so their verdicts
    // are simply lost. Scoped to THIS step's mining rows, never to downstream liveness: a
    // DEGRADED (`done`) step with live downstream work must still cascade-kill, and it can
    // never have live mining rows of its own (the barrier parks `waiting_cli` while any row is
    // pending/running). The web hides the button in this state too, but a stale tab or a direct
    // POST reaches here regardless.
    const liveAgents = await db
      .select({ id: schema.taskStepAgentMinings.id })
      .from(schema.taskStepAgentMinings)
      .where(
        and(
          eq(schema.taskStepAgentMinings.taskStepId, step.id),
          inArray(schema.taskStepAgentMinings.status, ['pending', 'running']),
        ),
      );
    if (liveAgents.length > 0) {
      throw new HttpError(
        409,
        `${liveAgents.length} terminal(s) are still running — wait for the fan-out to finish, or use Stop & retry to reset the whole step`,
        'fanout_in_flight',
      );
    }
    const failedAgents = await db
      .select({ id: schema.taskStepAgentMinings.id })
      .from(schema.taskStepAgentMinings)
      .where(
        and(
          eq(schema.taskStepAgentMinings.taskStepId, step.id),
          eq(schema.taskStepAgentMinings.status, 'failed'),
        ),
      );
    if (failedAgents.length > 0) {
      const now = new Date();
      // A step that DEGRADED ended `done` and the task moved past it, so whatever consumed its
      // verdict (08c2, gate 2) must be invalidated — that verdict is about to change. A step
      // sitting `failed` has nothing downstream that ran, and cascading there would destroy
      // work for no reason. This conditional is also what keeps 09_5-skill-generation, the one
      // step that is both a fan-out AND a loop, from cascading when it fails mid-loop.
      const targetSeq = step.runSeq;
      const downstream =
        step.status === 'done'
          ? await db
              .select()
              .from(schema.taskSteps)
              .where(
                and(
                  eq(schema.taskSteps.taskId, id),
                  eq(schema.taskSteps.round, step.round),
                  targetSeq != null
                    ? gt(schema.taskSteps.runSeq, targetSeq)
                    : gt(schema.taskSteps.stepIndex, step.stepIndex),
                ),
              )
          : [];
      const downstreamToReset = downstream.filter((r) => r.status !== 'pending');
      // Same rule as Retry: if anything in the set being reset is in flight, its sandbox has to
      // go first, or the reset row's CLI keeps running against a step that no longer owns it.
      // The clicked step counts too — a fan-out step can be re-run while its own barrier is
      // still parked. The web hides this action on a passed step, but the endpoint cannot rely
      // on that: a live downstream row reaching the reset below is the case that would leave
      // two steps live for the orchestrator's other-step-active guard to refuse.
      const liveInCascade =
        step.status === 'running' ||
        step.status === 'waiting_cli' ||
        downstreamToReset.some((r) => r.status === 'running' || r.status === 'waiting_cli');
      if (liveInCascade) {
        const killed = await killTaskSandboxes(id);
        logger.info({ taskId: id, stepId, killed }, 'killed sandboxes for fan-out resume');
      }
      let newEpoch = task.orchestrationEpoch;
      await db.transaction(async (tx) => {
        await tx
          .update(schema.taskStepAgentMinings)
          .set({ userRetryRequestedAt: now, updatedAt: now })
          .where(
            inArray(
              schema.taskStepAgentMinings.id,
              failedAgents.map((a) => a.id),
            ),
          );
        // Clear the step's OWN blocker before handing back to the worker; without it the
        // marker written above is never even read. See the helper for why.
        await supersedeBlockingInvocation(tx, step.id, now);
        // Downstream ONLY. The clicked step keeps its detectOutput / formSchema / formValues /
        // iterations / output and — the whole point — the `done` rows of the agents that
        // succeeded, which resetRowsForRerun would have deleted.
        await resetRowsForRerun(tx, id, downstreamToReset, now);
        await tx
          .update(schema.taskSteps)
          .set({
            status: 'running',
            errorMessage: null,
            errorHint: null,
            endedAt: null,
            // Re-opening a closed row: bill the gap since it closed as idle, not work.
            idleMs: CLOSED_GAP_INTO_IDLE_MS,
            statusMessage: null,
            updatedAt: now,
          })
          .where(eq(schema.taskSteps.id, step.id));
        const bumped = await tx
          .update(schema.tasks)
          .set({
            status: 'running',
            errorMessage: null,
            completedAt: null,
            allowanceAutoResumeCount: 0,
            currentStepId: stepId,
            currentStepIndex: step.runSeq ?? step.stepIndex,
            // Bumped like a retry: this re-run invalidates any advance still queued against
            // the state it is replacing.
            orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
            ...CLEAR_ALLOWANCE_WATCH,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, id))
          .returning({ epoch: schema.tasks.orchestrationEpoch });
        newEpoch = bumped[0]?.epoch ?? newEpoch;
        await tx.insert(schema.taskEvents).values({
          taskId: id,
          taskStepId: step.id,
          eventType: 'step.resume',
          payload: {
            stepId,
            round: step.round,
            retriedAgents: failedAgents.length,
            cascadedSteps: downstreamToReset.length,
            note: body.note ?? null,
          },
        });
      });
      await getTaskQueue().add(
        TASK_JOB_NAMES.ADVANCE_STEP,
        {
          taskId: id,
          userId,
          stepId,
          round: step.round,
          epoch: newEpoch,
        } as TaskJobPayload,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      return c.json({ ok: true, status: 'running', retriedAgents: failedAgents.length });
    }
    const isLoopStep = (STEP_CLI_ROLES[stepId]?.length ?? 0) > 0;
    if (step.iterationCount <= 0 && !isLoopStep) {
      throw new HttpError(
        409,
        'Resume is only available for a multi-iteration step — use Retry instead',
        'not_resumable',
      );
    }
    if (step.status === 'running' || step.status === 'waiting_cli') {
      const killed = await killTaskSandboxes(id);
      logger.info({ taskId: id, stepId, killed }, 'killed sandboxes for resume');
    }
    const now = new Date();
    // Supersede ONLY the failed pass's invocation (latest non-superseded,
    // non-consumed). Prior passes are already consumed; with this superseded,
    // resolveLlmPhase sees no live invocation and re-enqueues pass N afresh.
    await db
      .update(schema.cliInvocations)
      .set({ supersededAt: now })
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, step.id),
          isNull(schema.cliInvocations.supersededAt),
          isNull(schema.cliInvocations.consumedAt),
        ),
      );
    // Preserve detectOutput / formSchema / formValues / iterations / iterationCount
    // / output so advanceStep skips detect + form and the loop resumes at
    // upcomingIteration = iterations.length with the now-selected provider.
    await db
      .update(schema.taskSteps)
      .set({
        status: 'running',
        errorMessage: null,
        errorHint: null,
        endedAt: null,
        // Re-opening a closed row: bill the gap since it closed as idle, not work.
        idleMs: CLOSED_GAP_INTO_IDLE_MS,
        statusMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    await db
      .update(schema.tasks)
      // completedAt: null — a prior failure stamped it; leaving it set freezes the
      // task-level (global) UI timers (they key on !completedAt). Mirrors `retry`.
      .set({
        status: 'running',
        errorMessage: null,
        completedAt: null,
        // reset the auto-resume thrash counter: a manual action gives a fresh budget
        allowanceAutoResumeCount: 0,
        ...CLEAR_ALLOWANCE_WATCH,
        updatedAt: now,
      })
      .where(and(eq(schema.tasks.id, id), inArray(schema.tasks.status, ['failed', 'queued'])));
    await appendTaskEvent(db, id, step.id, 'step.resume', {
      stepId,
      fromIteration: step.iterationCount,
      note: body.note ?? null,
    });
    // Stamp the epoch (here and on the other recovery actions below) so a task-level retry
    // that bumps it invalidates this job instead of letting it run against the restarted
    // task. An UNSTAMPED job is exempt from the worker's epoch guard, which is how a stale
    // advance survived a retry and re-dispatched a step the restart had moved past. The
    // form submit / clarify endpoints stay unstamped on purpose: their job carries the
    // user's just-entered values, and silently dropping that reads as "nothing happened".
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      {
        taskId: id,
        userId,
        stepId,
        round: step.round,
        epoch: task.orchestrationEpoch,
      } as TaskJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return c.json({ ok: true, status: 'running', resumedFromIteration: step.iterationCount });
  }

  if (body.action === 'retry_ai') {
    // AI-assisted retry: keep the step's detect/form/values (like resume), but
    // record the failure context + a marker so the worker dispatches a
    // diagnose-and-fix agent before re-running apply.
    if (step.status !== 'failed') {
      throw new HttpError(409, 'retry_ai is only available on a failed step');
    }
    const now = new Date();
    const lastInv = await db
      .select({ rawOutput: schema.cliInvocations.rawOutput })
      .from(schema.cliInvocations)
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, step.id),
          isNull(schema.cliInvocations.supersededAt),
        ),
      )
      .orderBy(desc(schema.cliInvocations.createdAt))
      .limit(1);
    const aiFixContext = {
      priorError: step.errorMessage ?? '',
      priorOutput: (lastInv[0]?.rawOutput ?? '').slice(-2000),
    };
    // Supersede the failed pass's invocation, then preserve detect/form/values
    // and set the fix marker so advanceStep runs the fix agent next.
    await db
      .update(schema.cliInvocations)
      .set({ supersededAt: now })
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, step.id),
          isNull(schema.cliInvocations.supersededAt),
          isNull(schema.cliInvocations.consumedAt),
        ),
      );
    await db
      .update(schema.taskSteps)
      .set({
        status: 'running',
        errorMessage: null,
        errorHint: null,
        endedAt: null,
        // Re-opening a closed row: bill the gap since it closed as idle, not work.
        idleMs: CLOSED_GAP_INTO_IDLE_MS,
        statusMessage: null,
        aiFixContext,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    await db
      .update(schema.tasks)
      // completedAt: null — a prior failure stamped it; leaving it set freezes the
      // task-level (global) UI timers (they key on !completedAt). Mirrors `retry`.
      .set({
        status: 'running',
        errorMessage: null,
        completedAt: null,
        // reset the auto-resume thrash counter: a manual action gives a fresh budget
        allowanceAutoResumeCount: 0,
        ...CLEAR_ALLOWANCE_WATCH,
        updatedAt: now,
      })
      .where(and(eq(schema.tasks.id, id), inArray(schema.tasks.status, ['failed', 'queued'])));
    await appendTaskEvent(db, id, step.id, 'step.retry_ai', { stepId, note: body.note ?? null });
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      {
        taskId: id,
        userId,
        stepId,
        round: step.round,
        epoch: task.orchestrationEpoch,
      } as TaskJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return c.json({ ok: true, status: 'running' });
  }

  if (body.action === 'skip') {
    // Skip is disabled across the workflow except on the steps that opt in
    // (metadata.allowSkip), plus 01-worktree-setup for run_app (skip = run from
    // the project root instead of an isolated worktree/branch).
    if (!isStepSkippable(stepId, task.type)) {
      throw new HttpError(409, 'This step cannot be skipped');
    }
    if (step.status !== 'failed' && step.status !== 'waiting_form') {
      throw new HttpError(409, `Cannot skip step in status ${step.status}`);
    }
    const now = new Date();
    const closedIdleMs = step.waitingStartedAt
      ? Math.max(0, now.getTime() - step.waitingStartedAt.getTime())
      : 0;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'skipped',
          errorMessage: null,
          endedAt: now,
          idleMs: step.idleMs + closedIdleMs,
          waitingStartedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.taskSteps.id, step.id));
      await tx.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: step.id,
        eventType: 'step.skip',
        payload: { stepId, note: body.note ?? null },
      });
      await tx
        .update(schema.tasks)
        // completedAt: null — a prior failure stamped it; leaving it set freezes the
        // task-level (global) UI timers (they key on !completedAt). Mirrors `retry`.
        .set({
          status: 'running',
          errorMessage: null,
          completedAt: null,
          // reset the auto-resume thrash counter: a manual action gives a fresh budget
          allowanceAutoResumeCount: 0,
          ...CLEAR_ALLOWANCE_WATCH,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id));
    });
    // The api can't see unmaterialized future steps, so it can't compute the next
    // step. Enqueue an advance for the SKIPPED step; the worker sees it is already
    // terminal and advances to the next step via the registry run list — the same
    // path a step's own `skipped`/`done` result takes (handleResult → buildRunList).
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      {
        taskId: id,
        userId,
        stepId,
        round: step.round,
        epoch: task.orchestrationEpoch,
      } as TaskJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return c.json({ ok: true, status: 'skipped', nextStepId: null });
  }

  if (body.action === 'abort') {
    // Give up on this step → cancel the task. The definitive teardown (incl. the
    // per-task DDEV runner, which survives a plain failure so recovery can reuse
    // it). The step stays failed; the task goes terminal.
    await cancelTaskRow(db, id, { by: userId });
    await enqueueCancelJob(id, userId);
    await appendTaskEvent(db, id, step.id, 'step.abort', { stepId, note: body.note ?? null });
    return c.json({ ok: true, status: 'cancelled' });
  }

  throw new HttpError(400, 'Unknown step action');
});

/** List CLI invocations for a single step (most-recent first). Used by the
 *  per-step inline terminal to enumerate live + historical runs. Excludes
 *  superseded rows so retried invocations don't clutter the UI. */
stepRoutes.get('/:id/steps/:stepId/cli-invocations', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const step = await db.query.taskSteps.findFirst({
    where: and(eq(schema.taskSteps.id, stepId), eq(schema.taskSteps.taskId, id)),
    columns: { id: true },
  });
  if (!step) throw new HttpError(404, 'Step not found');
  const rows = await db
    .select({
      id: schema.cliInvocations.id,
      mode: schema.cliInvocations.mode,
      exitCode: schema.cliInvocations.exitCode,
      durationMs: schema.cliInvocations.durationMs,
      startedAt: schema.cliInvocations.startedAt,
      endedAt: schema.cliInvocations.endedAt,
      createdAt: schema.cliInvocations.createdAt,
      errorMessage: schema.cliInvocations.errorMessage,
      tokenUsage: schema.cliInvocations.tokenUsage,
      // Provider that ran this invocation, so the terminal badge can show which
      // CLI/model it was — important for multi-CLI loop steps (spec-quality).
      providerLabel: schema.cliProviders.label,
      providerName: schema.cliProviders.name,
      // The agent running this terminal: the mining persona (e.g.
      // "accessibility-specialist"), or — for multi-CLI loop steps — the role of this
      // pass (Validator / Fixer) stored on the invocation itself. Coalesce the two.
      agentTitle: sql<
        string | null
      >`coalesce(${schema.cliInvocations.agentTitle}, ${schema.taskStepAgentMinings.agentTitle})`,
      // This terminal's own latest activity line (per-invocation, not the shared
      // step status), so each terminal shows what it is actually doing.
      statusMessage: schema.cliInvocations.statusMessage,
    })
    .from(schema.cliInvocations)
    .leftJoin(schema.cliProviders, eq(schema.cliProviders.id, schema.cliInvocations.cliProviderId))
    .leftJoin(
      schema.taskStepAgentMinings,
      eq(schema.taskStepAgentMinings.cliInvocationId, schema.cliInvocations.id),
    )
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, step.id),
        isNull(schema.cliInvocations.supersededAt),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt));
  const invocations = rows.map((r) => ({
    ...r,
    isActive: r.endedAt === null,
  }));
  return c.json({ invocations });
});

/** Write (or clear) one (user, step, role) CLI preference. `role: 'default'` targets the
 *  single-CLI table; any other role the per-role table, which loop roles and fan-out seats
 *  share. Extracted because three callers must write it IDENTICALLY: a change on a step
 *  card, and the same change made from the CLIs tab before the step has a row. Two copies
 *  would let the panel and the card disagree about what "set this step's CLI" means.
 *
 *  Validates the provider first and throws the same 404/409 the card path has always
 *  thrown, so an unknown or disabled provider is rejected before anything is written. */
async function writeStepCliPreference(
  db: Database,
  userId: string,
  stepId: string,
  role: string,
  cliProviderId: string | null,
  requestedEffort: string | null | undefined,
): Promise<void> {
  if (!cliProviderId) {
    if (role === 'default') {
      await db
        .delete(schema.userStepCliPreferences)
        .where(
          and(
            eq(schema.userStepCliPreferences.userId, userId),
            eq(schema.userStepCliPreferences.stepId, stepId),
          ),
        );
      return;
    }
    await db
      .delete(schema.userStepCliRolePreferences)
      .where(
        and(
          eq(schema.userStepCliRolePreferences.userId, userId),
          eq(schema.userStepCliRolePreferences.stepId, stepId),
          eq(schema.userStepCliRolePreferences.role, role),
        ),
      );
    return;
  }
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, cliProviderId), eq(schema.cliProviders.userId, userId)),
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');
  if (!provider.enabled) throw new HttpError(409, 'CLI provider is disabled');
  const effortLevel = clampEffort(provider.name, requestedEffort);
  if (role === 'default') {
    await db
      .insert(schema.userStepCliPreferences)
      .values({ userId, stepId, cliProviderId, effortLevel, explicit: true })
      .onConflictDoUpdate({
        target: [schema.userStepCliPreferences.userId, schema.userStepCliPreferences.stepId],
        set: { cliProviderId, effortLevel, explicit: true, updatedAt: new Date() },
      });
    return;
  }
  await db
    .insert(schema.userStepCliRolePreferences)
    .values({ userId, stepId, role, cliProviderId, effortLevel, explicit: true })
    .onConflictDoUpdate({
      target: [
        schema.userStepCliRolePreferences.userId,
        schema.userStepCliRolePreferences.stepId,
        schema.userStepCliRolePreferences.role,
      ],
      set: { cliProviderId, effortLevel, explicit: true, updatedAt: new Date() },
    });
}

/** Track the touch so a task that opted out of saved prefs still honors this explicit
 *  mid-task choice (set) or reverts to the task provider (clear). No-op unless the task
 *  set ignore_saved_step_clis. Same three callers, same reason, as the write above. */
async function writeCliTouchMarker(
  db: Database,
  taskId: string,
  stepId: string,
  role: string,
  set: boolean,
): Promise<void> {
  if (set) {
    await db
      .insert(schema.taskStepCliTouched)
      .values({ taskId, stepId, role })
      .onConflictDoNothing();
    return;
  }
  await db
    .delete(schema.taskStepCliTouched)
    .where(
      and(
        eq(schema.taskStepCliTouched.taskId, taskId),
        eq(schema.taskStepCliTouched.stepId, stepId),
        eq(schema.taskStepCliTouched.role, role),
      ),
    );
}

stepRoutes.patch('/:id/steps/:stepId/cli-provider', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const body = setCliProviderRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: {
      id: true,
      status: true,
      ignoreSavedStepClis: true,
      // stamped on the re-advance below so a later task retry can invalidate it
      orchestrationEpoch: true,
    },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new HttpError(409, `Cannot change provider for ${task.status} task`);
  }

  // Act on the caller's round, latest as fallback (see the action endpoint):
  // a looped step recurs once per round; don't grab an arbitrary (round-0) row.
  const step = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, id),
      eq(schema.taskSteps.stepId, stepId),
      body.round !== undefined ? eq(schema.taskSteps.round, body.round) : undefined,
    ),
    columns: {
      id: true,
      status: true,
      iterationCount: true,
      round: true,
      // Timing fields for the carried_* fold when this change resets the step below.
      startedAt: true,
      endedAt: true,
      idleMs: true,
      userActiveMs: true,
      waitingStartedAt: true,
      carriedWorkMs: true,
      carriedIdleMs: true,
      carriedUserActiveMs: true,
    },
    orderBy: desc(schema.taskSteps.round),
  });
  // Named roles (e.g. reviewer/corrector) are stored per (user, step, role) and
  // resolved per loop iteration at dispatch time — no re-detect needed, unlike a
  // default-provider change below.
  const role = body.role ?? 'default';

  // No row: a CLI step the run has not reached yet, chosen from the CLIs tab. Preferences
  // are keyed (user, step, role) with no dependency on a row, and the worker's
  // resolvePreferredCli reads them at dispatch — so the write alone is the whole change.
  // Everything the row path does afterwards (detect invalidation, the model-health
  // propagation, the re-advance enqueue) is about re-running a step that already ran;
  // there is nothing here to reset and no job to re-drive. Gated on the dispatch catalog
  // so an unknown step id still 404s rather than accumulating preferences nothing reads.
  if (!step) {
    if (!CLI_DISPATCH_STEP_ID_SET.has(stepId)) throw new HttpError(404, 'Step not found');
    await writeStepCliPreference(db, userId, stepId, role, body.cliProviderId, body.effortLevel);
    if (task.ignoreSavedStepClis) {
      await writeCliTouchMarker(db, id, stepId, role, Boolean(body.cliProviderId));
    }
    await appendTaskEvent(db, id, null, 'step.cli_provider_preference_changed', {
      stepId,
      role,
      cliProviderId: body.cliProviderId,
      upcoming: true,
      by: userId,
    });
    return c.json({ ok: true, stepId, role, cliProviderId: body.cliProviderId });
  }
  if (step.status === 'running' || step.status === 'waiting_cli') {
    throw new HttpError(409, `Cannot change provider while step is ${step.status}`);
  }

  if (role !== 'default') {
    await writeStepCliPreference(db, userId, stepId, role, body.cliProviderId, body.effortLevel);
    if (task.ignoreSavedStepClis) {
      await writeCliTouchMarker(db, id, stepId, role, Boolean(body.cliProviderId));
    }
    await appendTaskEvent(db, id, step.id, 'step.cli_role_provider_changed', {
      stepId,
      role,
      cliProviderId: body.cliProviderId,
      by: userId,
    });
    return c.json({ ok: true, stepId, role, cliProviderId: body.cliProviderId });
  }

  await writeStepCliPreference(db, userId, stepId, role, body.cliProviderId, body.effortLevel);

  // A CLI swap on the model-health canary rewrites the task default so every later
  // step inherits the new model (see propagateModelHealthCliToTaskDefault). No-op
  // for any other step or when the pref was cleared rather than set.
  await propagateModelHealthCliToTaskDefault(db, {
    taskId: id,
    taskStepId: step.id,
    stepId,
    cliProviderId: body.cliProviderId ?? null,
    by: userId,
  });

  // Same touch tracking as the role path, for the 'default' single-CLI pref.
  if (task.ignoreSavedStepClis) {
    await writeCliTouchMarker(db, id, stepId, 'default', Boolean(body.cliProviderId));
  }

  // Invalidate the step's cached detect/form so the next advance re-detects
  // against the newly-preferred CLI's metadata. Skipped if step is terminal, and
  // for a mid-loop step (iterationCount > 0) so swapping the CLI before Resume
  // keeps the completed passes + the form instead of restarting the step.
  let invalidated = false;
  if (
    step.iterationCount === 0 &&
    (step.status === 'pending' || step.status === 'waiting_form' || step.status === 'failed')
  ) {
    // A failed step still carries its ended cli_invocation. Without superseding
    // it here, the re-advance below makes resolveLlmPhase re-read that old
    // invocation and re-surface its error (and its provider) instead of
    // dispatching the newly-selected CLI — so changing the provider on a failed
    // step appears to do nothing (the old CLI's terminal flashes, then its error
    // returns). Mirror the retry handler: supersede live invocations + drop
    // agent minings. Done before the status reset so a failure here leaves the
    // step failed (safe) rather than pending with a stale live invocation.
    await db
      .update(schema.cliInvocations)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(schema.cliInvocations.taskStepId, step.id),
          isNull(schema.cliInvocations.supersededAt),
        ),
      );
    await db
      .delete(schema.taskStepAgentMinings)
      .where(eq(schema.taskStepAgentMinings.taskStepId, step.id));
    // Fold the finishing run's timing into carried_* before zeroing, so switching the
    // CLI and re-running the step keeps its accrued work/idle/effort (same as retry).
    // computeFoldContribution avoids carrying an orphaned open run's span as work.
    const now = new Date();
    const contrib = computeFoldContribution(step, now.getTime());
    await db
      .update(schema.taskSteps)
      .set({
        status: 'pending',
        detectOutput: null,
        formSchema: null,
        statusMessage: null,
        startedAt: null,
        endedAt: null,
        errorMessage: null,
        idleMs: 0,
        waitingStartedAt: null,
        userActiveMs: 0,
        carriedWorkMs: step.carriedWorkMs + contrib.workMs,
        carriedIdleMs: step.carriedIdleMs + contrib.idleMs,
        carriedUserActiveMs: step.carriedUserActiveMs + contrib.userActiveMs,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    // Mirror the retry/resume handlers: a failed task must leave the failed state
    // and shed its stale top-level error when its failed step is reset + re-run via
    // a provider/model change, else the task page keeps showing the old error after
    // the re-run passes.
    await db
      .update(schema.tasks)
      .set({ status: 'running', errorMessage: null, updatedAt: new Date() })
      .where(and(eq(schema.tasks.id, id), inArray(schema.tasks.status, ['failed', 'queued'])));
    invalidated = true;
  }

  await appendTaskEvent(db, id, step.id, 'step.cli_provider_preference_changed', {
    stepId,
    cliProviderId: body.cliProviderId,
    by: userId,
  });

  // Re-enqueue the step so the worker re-runs detect/form against the new
  // CLI. Without this the step would sit in 'pending' forever and the user
  // would be stuck (no form to fill, no job in flight).
  if (invalidated) {
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      {
        taskId: id,
        userId,
        stepId,
        round: step.round,
        epoch: task.orchestrationEpoch,
      } as TaskJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
  }

  return c.json({ ok: true, stepId, cliProviderId: body.cliProviderId });
});
