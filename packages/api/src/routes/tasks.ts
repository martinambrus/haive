import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  createTaskRequestSchema,
  logger,
  PROVIDER_SENSITIVE_STEP_IDS,
  setCliProviderRequestSchema,
  stepActionRequestSchema,
  submitStepRequestSchema,
  taskActionRequestSchema,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { killTaskSandboxes } from '../lib/sandbox-kill.js';
import { cancelTaskRow, enqueueCancelJob } from '../lib/cancel-task.js';
import { getTaskQueue } from '../queues.js';

const MAX_FILE_CONTENT_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.php',
  '.sh',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.xml',
  '.env',
  '.lock',
  '.ini',
  '.conf',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
]);

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.use('*', requireAuth);

taskRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.tasks.findMany({
    where: eq(schema.tasks.userId, userId),
    orderBy: [desc(schema.tasks.createdAt)],
  });
  return c.json({ tasks: rows });
});

taskRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  const body = createTaskRequestSchema.parse(await c.req.json());
  const db = getDb();

  if (body.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: and(
        eq(schema.repositories.id, body.repositoryId),
        eq(schema.repositories.userId, userId),
      ),
      columns: { id: true },
    });
    if (!repo) throw new HttpError(404, 'Repository not found');
  }

  if (body.type === 'onboarding_upgrade') {
    if (!body.repositoryId) {
      throw new HttpError(400, 'onboarding_upgrade tasks require a repositoryId');
    }
    const priorOnboarding = await db.query.tasks.findFirst({
      where: and(
        eq(schema.tasks.repositoryId, body.repositoryId),
        eq(schema.tasks.userId, userId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.tasks.status, 'completed'),
      ),
      columns: { id: true },
    });
    const priorArtifact = await db.query.onboardingArtifacts.findFirst({
      where: and(
        eq(schema.onboardingArtifacts.repositoryId, body.repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
      columns: { id: true },
    });
    if (!priorOnboarding && !priorArtifact) {
      throw new HttpError(409, 'No completed onboarding found for this repository; cannot upgrade');
    }
  }

  if (body.cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(
        eq(schema.cliProviders.id, body.cliProviderId),
        eq(schema.cliProviders.userId, userId),
      ),
      columns: { id: true },
    });
    if (!provider) throw new HttpError(404, 'CLI provider not found');
  }

  const metadata: Record<string, unknown> | null = null;

  const inserted = await db
    .insert(schema.tasks)
    .values({
      userId,
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      repositoryId: body.repositoryId ?? null,
      cliProviderId: body.cliProviderId ?? null,
      memoryLimitMb: body.resourceLimits?.memoryLimitMb ?? null,
      cpuLimitMilli: body.resourceLimits?.cpuLimitMilli ?? null,
      stepLoopLimits: body.stepLoopLimits ?? {},
      metadata,
      status: 'created',
    })
    .returning();

  const task = inserted[0];
  if (!task) throw new HttpError(500, 'Failed to create task');

  await appendTaskEvent(db, task.id, null, 'task.created', { userId });

  const queue = getTaskQueue();
  const payload: TaskJobPayload = { taskId: task.id, userId };
  await queue.add(TASK_JOB_NAMES.START, payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  return c.json({ task }, 201);
});

async function enrichStepsWithCliPreferences<T extends { stepId: string }>(
  db: ReturnType<typeof getDb>,
  userId: string,
  steps: T[],
): Promise<(T & { preferredCliProviderId: string | null })[]> {
  const stepIds = [...new Set(steps.map((s) => s.stepId))];
  if (stepIds.length === 0) return steps.map((s) => ({ ...s, preferredCliProviderId: null }));
  const prefs = await db
    .select()
    .from(schema.userStepCliPreferences)
    .where(
      and(
        eq(schema.userStepCliPreferences.userId, userId),
        inArray(schema.userStepCliPreferences.stepId, stepIds),
      ),
    );
  const byStep = new Map(prefs.map((p) => [p.stepId, p.cliProviderId]));
  return steps.map((s) => ({ ...s, preferredCliProviderId: byStep.get(s.stepId) ?? null }));
}

async function findActiveCliInvocation(
  db: ReturnType<typeof getDb>,
  taskId: string,
): Promise<{ id: string; taskStepId: string | null } | null> {
  const rows = await db
    .select({
      id: schema.cliInvocations.id,
      taskStepId: schema.cliInvocations.taskStepId,
    })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    )
    .orderBy(desc(schema.cliInvocations.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Annotate each step with the count of non-superseded CLI invocations
 *  attached to it. The web UI uses this to suppress the inline terminal
 *  toggle on steps that have never spawned a CLI (deterministic-only steps,
 *  pending steps), so the chevron only appears where it has something to
 *  reveal. Single GROUP BY keeps it O(1) round-trips regardless of step
 *  count. */
async function enrichStepsWithCliInvocationCount<T extends { id: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { cliInvocationCount: number })[]> {
  if (steps.length === 0) return [];
  const rows = await db
    .select({
      taskStepId: schema.cliInvocations.taskStepId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.cliInvocations)
    .where(
      and(eq(schema.cliInvocations.taskId, taskId), isNull(schema.cliInvocations.supersededAt)),
    )
    .groupBy(schema.cliInvocations.taskStepId);
  const byStep = new Map<string, number>();
  for (const row of rows) {
    if (row.taskStepId) byStep.set(row.taskStepId, row.count);
  }
  return steps.map((s) => ({ ...s, cliInvocationCount: byStep.get(s.id) ?? 0 }));
}

async function enrichStepsWithSkipFlag<T extends { id: string; status: string }>(
  db: ReturnType<typeof getDb>,
  taskId: string,
  steps: T[],
): Promise<(T & { manuallySkipped: boolean })[]> {
  const skippedIds = steps.filter((s) => s.status === 'skipped').map((s) => s.id);
  if (skippedIds.length === 0) return steps.map((s) => ({ ...s, manuallySkipped: false }));
  const events = await db
    .select({ taskStepId: schema.taskEvents.taskStepId })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, 'step.skip'),
        inArray(schema.taskEvents.taskStepId, skippedIds),
      ),
    );
  const manualSet = new Set(events.map((e) => e.taskStepId).filter((v): v is string => !!v));
  return steps.map((s) => ({ ...s, manuallySkipped: manualSet.has(s.id) }));
}

taskRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
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
  const active = await findActiveCliInvocation(db, id);
  const taskWithActive = {
    ...task,
    activeCliInvocationId: active?.id ?? null,
    activeCliStepId: active?.taskStepId ?? null,
  };
  return c.json({ task: taskWithActive, steps });
});

taskRoutes.get('/:id/steps', async (c) => {
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

taskRoutes.post('/:id/steps/:stepId/submit', async (c) => {
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

  await db
    .update(schema.taskSteps)
    .set({ formValues: body.values, updatedAt: new Date() })
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

taskRoutes.post('/:id/steps/:stepId/action', async (c) => {
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
          statusMessage: null,
          errorMessage: null,
          errorHint: null,
          startedAt: null,
          endedAt: null,
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
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'skipped',
          errorMessage: null,
          endedAt: now,
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

taskRoutes.post('/:id/action', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = taskActionRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');

  switch (body.action) {
    case 'cancel':
      if (task.status === 'completed' || task.status === 'cancelled') {
        return c.json({ ok: true, status: task.status });
      }
      await cancelTaskRow(db, id, { by: userId });
      await enqueueCancelJob(id, userId);
      return c.json({ ok: true, status: 'cancelled' });
    case 'retry':
      if (task.status !== 'failed') {
        throw new HttpError(409, `Cannot retry task in status ${task.status}`);
      }
      await db
        .update(schema.tasks)
        .set({
          status: 'queued',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, id));
      await appendTaskEvent(db, id, null, 'task.retried', { by: userId });
      await getTaskQueue().add(TASK_JOB_NAMES.START, { taskId: id, userId } as TaskJobPayload, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      return c.json({ ok: true, status: 'queued' });
    default:
      throw new HttpError(400, 'Unknown action');
  }
});

async function resolveWorkspaceRoot(
  db: ReturnType<typeof getDb>,
  taskId: string,
  userId: string,
): Promise<{ task: typeof schema.tasks.$inferSelect; root: string }> {
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');

  let root: string | null = null;
  if (task.worktreePath) {
    root = task.worktreePath;
  } else if (task.repositoryId) {
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    root = repo?.storagePath ?? repo?.localPath ?? null;
  }
  if (!root) {
    throw new HttpError(409, 'Task has no resolvable workspace path');
  }
  return { task, root: resolve(root) };
}

function validateWorkspacePath(root: string, requested: string | undefined): string {
  const target = requested ? resolve(requested) : root;
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel === '..' || rel.includes('\0')) {
    throw new HttpError(403, 'Path is outside the task workspace');
  }
  return target;
}

taskRoutes.post('/:id/cancel-active-cli', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  // The CLI process inside the killed container exits non-zero; the worker's
  // executeCliSpec finalizes the cli_invocations row and the step transitions
  // to `failed`. From there the user can hit Retry. We deliberately do NOT
  // reset the step here — that's a separate action.
  const killed = await killTaskSandboxes(id);
  logger.info({ taskId: id, killed }, 'cancel-active-cli killed sandboxes');
  return c.json({ ok: true, killed });
});

/** List CLI invocations for a single step (most-recent first). Used by the
 *  per-step inline terminal to enumerate live + historical runs. Excludes
 *  superseded rows so retried invocations don't clutter the UI. */
taskRoutes.get('/:id/steps/:stepId/cli-invocations', async (c) => {
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

/** Static replay endpoint for an ended CLI invocation. Live invocations should
 *  use the WS stream at /cli-stream/:invocationId — this returns the persisted
 *  rawOutput once endedAt is set. Returns the raw column even for active rows
 *  so the caller can render whatever has flushed to the DB so far without
 *  having to upgrade to WS. */
taskRoutes.get('/:id/cli-invocations/:invocationId/output', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const invocationId = c.req.param('invocationId');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const inv = await db.query.cliInvocations.findFirst({
    where: and(eq(schema.cliInvocations.id, invocationId), eq(schema.cliInvocations.taskId, id)),
    columns: {
      id: true,
      rawOutput: true,
      streamLog: true,
      exitCode: true,
      errorMessage: true,
      endedAt: true,
      durationMs: true,
    },
  });
  if (!inv) throw new HttpError(404, 'CLI invocation not found');
  // Prefer the full live-stream transcript when present; fall back to the
  // parsed result text on rows written before stream_log existed so the
  // historical replay still shows something meaningful.
  return c.json({
    id: inv.id,
    rawOutput: inv.streamLog ?? inv.rawOutput ?? '',
    exitCode: inv.exitCode,
    errorMessage: inv.errorMessage,
    durationMs: inv.durationMs,
    isActive: inv.endedAt === null,
  });
});

taskRoutes.get('/:id/files', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { root } = await resolveWorkspaceRoot(db, id, userId);

  const requested = c.req.query('path') ?? root;
  const dir = validateWorkspacePath(root, requested);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(404, 'Directory not found or unreadable');
  }

  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      let size: number | null = null;
      try {
        const s = await stat(fullPath);
        size = entry.isFile() ? s.size : null;
      } catch {
        // ignore stat failures
      }
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        hidden: entry.name.startsWith('.'),
        size,
      };
    }),
  );

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = dir === root ? null : dirname(dir);
  return c.json({ path: dir, parent, root, entries: result });
});

taskRoutes.get('/:id/files/content', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { root } = await resolveWorkspaceRoot(db, id, userId);

  const requested = c.req.query('path');
  if (!requested) throw new HttpError(400, 'Missing path query parameter');
  const target = validateWorkspacePath(root, requested);

  let st;
  try {
    st = await stat(target);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (st.isDirectory()) {
    throw new HttpError(400, 'Path is a directory, not a file');
  }

  const truncated = st.size > MAX_FILE_CONTENT_BYTES;
  const readSize = Math.min(st.size, MAX_FILE_CONTENT_BYTES);
  const buf = Buffer.alloc(readSize);
  const fh = await open(target, 'r');
  try {
    await fh.read({ buffer: buf, offset: 0, position: 0, length: readSize });
  } finally {
    await fh.close();
  }

  const ext = extname(target).toLowerCase();
  const name = basename(target);
  const isText =
    TEXT_EXTENSIONS.has(ext) ||
    TEXT_EXTENSIONS.has(name.toLowerCase()) ||
    name.toLowerCase() === 'claude.md' ||
    name.toLowerCase() === 'agents.md' ||
    name.toLowerCase() === 'readme' ||
    name.toLowerCase() === 'license';

  if (!isText) {
    return c.json({
      path: target,
      size: st.size,
      binary: true,
      truncated,
      content: null,
    });
  }

  const content = buf.toString('utf8');
  return c.json({
    path: target,
    size: st.size,
    binary: false,
    truncated,
    content,
  });
});

taskRoutes.patch('/:id/cli-provider', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = setCliProviderRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new HttpError(409, `Cannot change provider for ${task.status} task`);
  }

  if (body.cliProviderId) {
    const provider = await db.query.cliProviders.findFirst({
      where: and(
        eq(schema.cliProviders.id, body.cliProviderId),
        eq(schema.cliProviders.userId, userId),
      ),
    });
    if (!provider) throw new HttpError(404, 'CLI provider not found');
    if (!provider.enabled) {
      throw new HttpError(409, 'CLI provider is disabled');
    }
  }

  await db
    .update(schema.tasks)
    .set({
      cliProviderId: body.cliProviderId,
      updatedAt: new Date(),
    })
    .where(eq(schema.tasks.id, id));

  await appendTaskEvent(db, id, null, 'task.cli_provider_changed', {
    cliProviderId: body.cliProviderId,
    by: userId,
  });

  // Invalidate cached detect output on provider-sensitive steps so the next
  // advance re-detects against the new CLI's metadata (skills dir, agents
  // dir, etc.). Terminal (done/failed/skipped/cancelled) steps are left
  // alone — rewriting history would be confusing. form_values is preserved
  // so the user's prior submission flows into the regenerated schema.
  const invalidated = await db
    .update(schema.taskSteps)
    .set({
      status: 'pending',
      detectOutput: null,
      formSchema: null,
      statusMessage: null,
      startedAt: null,
      endedAt: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.taskSteps.taskId, id),
        inArray(schema.taskSteps.stepId, [...PROVIDER_SENSITIVE_STEP_IDS]),
        inArray(schema.taskSteps.status, ['pending', 'running', 'waiting_form', 'waiting_cli']),
      ),
    )
    .returning({ stepId: schema.taskSteps.stepId });

  if (invalidated.length > 0) {
    await appendTaskEvent(db, id, null, 'task.provider_sensitive_steps_invalidated', {
      stepIds: invalidated.map((r) => r.stepId),
      cliProviderId: body.cliProviderId,
    });
  }

  return c.json({
    ok: true,
    cliProviderId: body.cliProviderId,
    invalidatedSteps: invalidated.map((r) => r.stepId),
  });
});

taskRoutes.patch('/:id/steps/:stepId/cli-provider', async (c) => {
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
      .values({ userId, stepId, cliProviderId: body.cliProviderId })
      .onConflictDoUpdate({
        target: [schema.userStepCliPreferences.userId, schema.userStepCliPreferences.stepId],
        set: { cliProviderId: body.cliProviderId, updatedAt: new Date() },
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

taskRoutes.get('/:id/events', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const events = await db
    .select()
    .from(schema.taskEvents)
    .where(eq(schema.taskEvents.taskId, id))
    .orderBy(asc(schema.taskEvents.createdAt));
  return c.json({ events });
});

async function appendTaskEvent(
  db: ReturnType<typeof getDb>,
  taskId: string,
  taskStepId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType,
    payload,
  });
}
