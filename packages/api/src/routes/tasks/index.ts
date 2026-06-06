import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  createTaskRequestSchema,
  logger,
  PROVIDER_SENSITIVE_STEP_IDS,
  renameTaskRequestSchema,
  setCliProviderRequestSchema,
  taskActionRequestSchema,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError, type AppEnv } from '../../context.js';
import { killTaskSandboxes } from '../../lib/sandbox-kill.js';
import { cancelTaskRow, enqueueCancelJob } from '../../lib/cancel-task.js';
import { getTaskQueue } from '../../queues.js';
import {
  appendTaskEvent,
  enrichStepsWithCliInvocationCount,
  enrichStepsWithCliPreferences,
  enrichStepsWithSkipFlag,
  findActiveCliInvocation,
} from './_helpers.js';
import { fileRoutes } from './files.js';
import { stepRoutes } from './steps.js';

export const taskRoutes = new Hono<AppEnv>();

taskRoutes.use('*', requireAuth);

taskRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.tasks.findMany({
    where: eq(schema.tasks.userId, userId),
    orderBy: [desc(schema.tasks.createdAt)],
    with: { repository: { columns: { id: true, name: true } } },
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

taskRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    with: { repository: { columns: { id: true, name: true } } },
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

taskRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = renameTaskRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
    columns: { id: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  const updated = await db
    .update(schema.tasks)
    .set({ title: body.title, updatedAt: new Date() })
    .where(eq(schema.tasks.id, id))
    .returning();

  await appendTaskEvent(db, id, null, 'task.renamed', { title: body.title, by: userId });

  return c.json({ task: updated[0] });
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
      idleMs: 0,
      waitingStartedAt: null,
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

// Step submit/action/skip + per-step CLI routes. Mounted at '/' so the
// sub-router registers the same full `/:id/steps/...` paths as before.
taskRoutes.route('/', stepRoutes);

// Workspace browse/read/download routes. Mounted at '/' so the sub-router
// registers the same full `/:id/files...` paths as before.
taskRoutes.route('/', fileRoutes);
