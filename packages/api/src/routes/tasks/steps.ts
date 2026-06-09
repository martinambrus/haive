import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  logger,
  setCliProviderRequestSchema,
  stepActionRequestSchema,
  submitStepRequestSchema,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';
import { killTaskSandboxes } from '../../lib/sandbox-kill.js';
import { getTaskQueue } from '../../queues.js';
import {
  appendTaskEvent,
  enrichStepsWithCliInvocationCount,
  enrichStepsWithCliPreferences,
  enrichStepsWithSkipFlag,
} from './_helpers.js';

export const stepRoutes = new Hono<AppEnv>();

stepRoutes.get('/:id/steps', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, id))
    .orderBy(asc(schema.taskSteps.stepIndex));
  const enriched = await enrichStepsWithCliPreferences(db, userId, stepRows);
  const withSkip = await enrichStepsWithSkipFlag(db, id, enriched);
  const steps = await enrichStepsWithCliInvocationCount(db, id, withSkip);
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

stepRoutes.post('/:id/steps/:stepId/user-active', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const stepId = c.req.param('stepId');
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
      .where(and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.stepId, stepId)));
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

  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.stepId, stepId)))
    .limit(1);
  const step = stepRows[0];
  if (!step) throw new HttpError(404, 'Step not found');
  if (step.status !== 'waiting_form') {
    throw new HttpError(409, `Step is in status ${step.status}, not waiting_form`);
  }

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

  const stepRows = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.stepId, stepId)))
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
      await tx
        .update(schema.tasks)
        .set({
          status: 'running',
          errorMessage: null,
          completedAt: null,
          currentStepId: stepId,
          currentStepIndex: step.stepIndex,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id));
      await tx.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: step.id,
        eventType: 'step.retry',
        payload: {
          stepId,
          note: body.note ?? null,
          priorStatus: step.status,
          cascadedSteps: downstreamToReset.length,
        },
      });
    });
    await getTaskQueue().add(
      TASK_JOB_NAMES.ADVANCE_STEP,
      { taskId: id, userId, stepId } as TaskJobPayload,
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return c.json({ ok: true, status: 'pending' });
  }

  if (body.action === 'skip') {
    if (step.status !== 'failed' && step.status !== 'waiting_form') {
      throw new HttpError(409, `Cannot skip step in status ${step.status}`);
    }
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const closedIdleMs = step.waitingStartedAt
        ? Math.max(0, now.getTime() - step.waitingStartedAt.getTime())
        : 0;
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

      const nextRows = await tx
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, id))
        .orderBy(asc(schema.taskSteps.stepIndex));
      const currentIdx = nextRows.findIndex((r) => r.id === step.id);
      const next = currentIdx >= 0 ? nextRows[currentIdx + 1] : undefined;

      if (next) {
        await tx
          .update(schema.tasks)
          .set({
            status: 'running',
            errorMessage: null,
            currentStepId: next.stepId,
            currentStepIndex: next.stepIndex,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, id));
        return { completed: false as const, nextStepId: next.stepId };
      }

      await tx
        .update(schema.tasks)
        .set({
          status: 'completed',
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id));
      await tx.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: null,
        eventType: 'task.completed',
        payload: { reason: 'skip-to-end' },
      });
      return { completed: true as const, nextStepId: null };
    });

    if (!result.completed) {
      await getTaskQueue().add(
        TASK_JOB_NAMES.ADVANCE_STEP,
        { taskId: id, userId, stepId: result.nextStepId } as TaskJobPayload,
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
      return c.json({
        ok: true,
        status: 'skipped',
        nextStepId: result.nextStepId,
      });
    }
    return c.json({ ok: true, status: 'skipped', nextStepId: null });
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
    })
    .from(schema.cliInvocations)
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
    columns: { id: true, status: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new HttpError(409, `Cannot change provider for ${task.status} task`);
  }

  const step = await db.query.taskSteps.findFirst({
    where: and(eq(schema.taskSteps.taskId, id), eq(schema.taskSteps.stepId, stepId)),
    columns: { id: true, status: true },
  });
  if (!step) throw new HttpError(404, 'Step not found');
  if (step.status === 'running' || step.status === 'waiting_cli') {
    throw new HttpError(409, `Cannot change provider while step is ${step.status}`);
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

  // Invalidate the step's cached detect/form so the next advance re-detects
  // against the newly-preferred CLI's metadata. Skipped if step is terminal.
  let invalidated = false;
  if (step.status === 'pending' || step.status === 'waiting_form' || step.status === 'failed') {
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
      { taskId: id, userId, stepId } as TaskJobPayload,
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
