import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  clarifyStepRequestSchema,
  logger,
  MERGE_CLARIFICATION_ANSWERED_EVENT,
  setCliProviderRequestSchema,
  SKIPPABLE_STEP_IDS,
  stepActionRequestSchema,
  STEP_CLI_ROLES,
  submitStepRequestSchema,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';
import { killTaskSandboxes } from '../../lib/sandbox-kill.js';
import { cancelTaskRow, enqueueCancelJob } from '../../lib/cancel-task.js';
import { getTaskQueue } from '../../queues.js';
import {
  appendTaskEvent,
  enrichStepsWithActiveRole,
  enrichStepsWithCliStats,
  enrichStepsWithCliPreferences,
  enrichStepsWithSkipFlag,
  propagateModelHealthCliToTaskDefault,
} from './_helpers.js';

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
    // Chronological (creation) order — kept identical to GET /tasks/:id (index.ts):
    // createdAt reflects fix-loop run order (round-0 sequence, then the round-1 block,
    // then post-loop round-0 steps), whereas a round-primary sort would hoist the
    // post-loop steps above the round-1 block. stepIndex breaks ties.
    .orderBy(asc(schema.taskSteps.createdAt), asc(schema.taskSteps.stepIndex));
  const enriched = await enrichStepsWithCliPreferences(
    db,
    userId,
    stepRows,
    id,
    task.ignoreSavedStepClis,
  );
  const withSkip = await enrichStepsWithSkipFlag(db, id, enriched);
  const withStats = await enrichStepsWithCliStats(db, id, withSkip);
  const steps = await enrichStepsWithActiveRole(db, id, withStats);
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
    const downstream = await db
      .select()
      .from(schema.taskSteps)
      .where(and(eq(schema.taskSteps.taskId, id), gt(schema.taskSteps.stepIndex, step.stepIndex)));

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
      const downstreamToReset = downstream.filter((r) => r.status !== 'pending').map((r) => r.id);
      const allStepIds = [step.id, ...downstreamToReset];

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
      // Clearing formSchema is essential: step-runner only re-renders the form
      // when persistedSchema is null (step-runner.ts ~L287). Without this, a
      // retry would re-run the LLM but reuse the stale form schema.
      // formValues is cleared so the user re-confirms inputs against the
      // (possibly different) regenerated schema.
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'pending',
          detectOutput: null,
          formSchema: null,
          formValues: null,
          output: null,
          // Loop state must reset too. Leaving a stale iterationCount/iterations
          // makes a retried loop step (e.g. spec quality) resume at the old count —
          // past its budget — and carry the prior passes forward instead of starting
          // a clean loop.
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
          updatedAt: now,
        })
        .where(inArray(schema.taskSteps.id, allStepIds));
      // Per-step "Override and run": only the clicked step bypasses the
      // unsafe-for-local-models guard on re-run. A plain retry sets this false
      // (re-arming the guard); the override button sets it true. Scoped to
      // step.id so the downstream cascade keeps its own override state.
      await tx
        .update(schema.taskSteps)
        .set({ localModelOverride: body.overrideLocalModel === true })
        .where(eq(schema.taskSteps.id, step.id));
      const bumped = await tx
        .update(schema.tasks)
        .set({
          status: 'running',
          errorMessage: null,
          completedAt: null,
          currentStepId: stepId,
          currentStepIndex: step.stepIndex,
          // Bump the orchestration epoch so any advance-step job still queued from
          // before this retry is skipped as stale (a retry stops in-flight work first).
          orchestrationEpoch: sql`${schema.tasks.orchestrationEpoch} + 1`,
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
        statusMessage: null,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    await db
      .update(schema.tasks)
      .set({ status: 'running', errorMessage: null, updatedAt: now })
      .where(and(eq(schema.tasks.id, id), inArray(schema.tasks.status, ['failed', 'queued'])));
    await appendTaskEvent(db, id, step.id, 'step.resume', {
      stepId,
      fromIteration: step.iterationCount,
      note: body.note ?? null,
    });
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      { taskId: id, userId, stepId, round: step.round } as TaskJobPayload,
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
        statusMessage: null,
        aiFixContext,
        updatedAt: now,
      })
      .where(eq(schema.taskSteps.id, step.id));
    await db
      .update(schema.tasks)
      .set({ status: 'running', errorMessage: null, updatedAt: now })
      .where(and(eq(schema.tasks.id, id), inArray(schema.tasks.status, ['failed', 'queued'])));
    await appendTaskEvent(db, id, step.id, 'step.retry_ai', { stepId, note: body.note ?? null });
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      { taskId: id, userId, stepId, round: step.round } as TaskJobPayload,
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
    // (metadata.allowSkip) — currently only the DB-migration step.
    if (!SKIPPABLE_STEP_IDS.includes(stepId)) {
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
        .set({ status: 'running', errorMessage: null, updatedAt: now })
        .where(eq(schema.tasks.id, id));
    });
    // The api can't see unmaterialized future steps, so it can't compute the next
    // step. Enqueue an advance for the SKIPPED step; the worker sees it is already
    // terminal and advances to the next step via the registry run list — the same
    // path a step's own `skipped`/`done` result takes (handleResult → buildRunList).
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      { taskId: id, userId, stepId, round: step.round } as TaskJobPayload,
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

stepRoutes.patch('/:id/steps/:stepId/cli-provider', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
  const body = setCliProviderRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true, status: true, ignoreSavedStepClis: true },
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
    columns: { id: true, status: true, iterationCount: true, round: true },
    orderBy: desc(schema.taskSteps.round),
  });
  if (!step) throw new HttpError(404, 'Step not found');
  if (step.status === 'running' || step.status === 'waiting_cli') {
    throw new HttpError(409, `Cannot change provider while step is ${step.status}`);
  }

  // Named roles (e.g. reviewer/corrector) are stored per (user, step, role) and
  // resolved per loop iteration at dispatch time — no re-detect needed, unlike a
  // default-provider change below.
  const role = body.role ?? 'default';
  if (role !== 'default') {
    if (body.cliProviderId) {
      const provider = await db.query.cliProviders.findFirst({
        where: and(
          eq(schema.cliProviders.id, body.cliProviderId),
          eq(schema.cliProviders.userId, userId),
        ),
      });
      if (!provider) throw new HttpError(404, 'CLI provider not found');
      if (!provider.enabled) throw new HttpError(409, 'CLI provider is disabled');
      await db
        .insert(schema.userStepCliRolePreferences)
        .values({ userId, stepId, role, cliProviderId: body.cliProviderId, explicit: true })
        .onConflictDoUpdate({
          target: [
            schema.userStepCliRolePreferences.userId,
            schema.userStepCliRolePreferences.stepId,
            schema.userStepCliRolePreferences.role,
          ],
          set: { cliProviderId: body.cliProviderId, explicit: true, updatedAt: new Date() },
        });
    } else {
      await db
        .delete(schema.userStepCliRolePreferences)
        .where(
          and(
            eq(schema.userStepCliRolePreferences.userId, userId),
            eq(schema.userStepCliRolePreferences.stepId, stepId),
            eq(schema.userStepCliRolePreferences.role, role),
          ),
        );
    }
    // Track the touch so a task that opted out of saved prefs still honors this
    // explicit mid-task choice (set) or reverts to the task provider (clear).
    if (task.ignoreSavedStepClis) {
      if (body.cliProviderId) {
        await db
          .insert(schema.taskStepCliTouched)
          .values({ taskId: id, stepId, role })
          .onConflictDoNothing();
      } else {
        await db
          .delete(schema.taskStepCliTouched)
          .where(
            and(
              eq(schema.taskStepCliTouched.taskId, id),
              eq(schema.taskStepCliTouched.stepId, stepId),
              eq(schema.taskStepCliTouched.role, role),
            ),
          );
      }
    }
    await appendTaskEvent(db, id, step.id, 'step.cli_role_provider_changed', {
      stepId,
      role,
      cliProviderId: body.cliProviderId,
      by: userId,
    });
    return c.json({ ok: true, stepId, role, cliProviderId: body.cliProviderId });
  }

  if (body.cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(
        eq(schema.cliProviders.id, body.cliProviderId),
        eq(schema.cliProviders.userId, userId),
      ),
    });
    if (!provider) throw new HttpError(404, 'CLI provider not found');
    if (!provider.enabled) throw new HttpError(409, 'CLI provider is disabled');
    await db
      .insert(schema.userStepCliPreferences)
      .values({ userId, stepId, cliProviderId: body.cliProviderId, explicit: true })
      .onConflictDoUpdate({
        target: [schema.userStepCliPreferences.userId, schema.userStepCliPreferences.stepId],
        set: { cliProviderId: body.cliProviderId, explicit: true, updatedAt: new Date() },
      });
  } else {
    await db
      .delete(schema.userStepCliPreferences)
      .where(
        and(
          eq(schema.userStepCliPreferences.userId, userId),
          eq(schema.userStepCliPreferences.stepId, stepId),
        ),
      );
  }

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
    if (body.cliProviderId) {
      await db
        .insert(schema.taskStepCliTouched)
        .values({ taskId: id, stepId, role: 'default' })
        .onConflictDoNothing();
    } else {
      await db
        .delete(schema.taskStepCliTouched)
        .where(
          and(
            eq(schema.taskStepCliTouched.taskId, id),
            eq(schema.taskStepCliTouched.stepId, stepId),
            eq(schema.taskStepCliTouched.role, 'default'),
          ),
        );
    }
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
        updatedAt: new Date(),
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
      { taskId: id, userId, stepId, round: step.round } as TaskJobPayload,
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
