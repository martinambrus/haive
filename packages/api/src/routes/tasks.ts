import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { and, asc, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  createTaskRequestSchema,
  overrideNextStepRequestSchema,
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
  });
  if (!task) throw new HttpError(404, 'Task not found');
  const steps = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, id))
    .orderBy(asc(schema.taskSteps.stepIndex));
  return c.json({ task, steps });
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
  const steps = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, id))
    .orderBy(asc(schema.taskSteps.stepIndex));
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
    if (step.status !== 'failed') {
      throw new HttpError(409, `Cannot retry step in status ${step.status}`);
    }
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'pending',
          errorMessage: null,
          endedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.taskSteps.id, step.id));
      await tx
        .update(schema.tasks)
        .set({
          status: 'running',
          errorMessage: null,
          currentStepId: stepId,
          currentStepIndex: step.stepIndex,
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, id));
      await tx.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: step.id,
        eventType: 'step.retry',
        payload: { stepId, note: body.note ?? null },
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
    case 'pause':
      if (task.status !== 'running') {
        throw new HttpError(409, `Cannot pause task in status ${task.status}`);
      }
      await db
        .update(schema.tasks)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(eq(schema.tasks.id, id));
      await appendTaskEvent(db, id, null, 'task.paused', { by: userId });
      return c.json({ ok: true, status: 'paused' });
    case 'resume':
      if (task.status !== 'paused') {
        throw new HttpError(409, `Cannot resume task in status ${task.status}`);
      }
      await db
        .update(schema.tasks)
        .set({ status: 'running', updatedAt: new Date() })
        .where(eq(schema.tasks.id, id));
      await appendTaskEvent(db, id, null, 'task.resumed', { by: userId });
      return c.json({ ok: true, status: 'running' });
    case 'cancel':
      if (task.status === 'completed' || task.status === 'cancelled') {
        return c.json({ ok: true, status: task.status });
      }
      await db
        .update(schema.tasks)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, id));
      await appendTaskEvent(db, id, null, 'task.cancelled', { by: userId });
      await getTaskQueue().add(TASK_JOB_NAMES.CANCEL, { taskId: id, userId } as TaskJobPayload, {
        removeOnComplete: 50,
        removeOnFail: 50,
      });
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

  return c.json({ ok: true, cliProviderId: body.cliProviderId });
});

taskRoutes.post('/:id/override-next-step', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = overrideNextStepRequestSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)),
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new HttpError(409, `Cannot override step on ${task.status} task`);
  }

  const allSteps = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, id))
    .orderBy(asc(schema.taskSteps.stepIndex));

  const target = allSteps.find((s) => s.stepId === body.stepId);
  if (!target) {
    throw new HttpError(404, `Step ${body.stepId} not found on task`);
  }

  const currentIdx = task.currentStepId
    ? allSteps.findIndex((s) => s.stepId === task.currentStepId)
    : -1;
  const targetIdx = allSteps.findIndex((s) => s.stepId === body.stepId);
  if (currentIdx >= 0 && targetIdx < currentIdx) {
    throw new HttpError(400, 'Backward overrides are not supported; use step retry instead');
  }

  await db.transaction(async (tx) => {
    const now = new Date();
    for (let i = 0; i < targetIdx; i += 1) {
      const row = allSteps[i];
      if (!row) continue;
      if (row.status === 'done' || row.status === 'skipped') continue;
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'skipped',
          errorMessage: null,
          endedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.taskSteps.id, row.id));
      await tx.insert(schema.taskEvents).values({
        taskId: id,
        taskStepId: row.id,
        eventType: 'step.skip',
        payload: { stepId: row.stepId, reason: 'override-next-step' },
      });
    }
    if (target.status !== 'pending') {
      await tx
        .update(schema.taskSteps)
        .set({
          status: 'pending',
          errorMessage: null,
          endedAt: null,
          updatedAt: now,
        })
        .where(eq(schema.taskSteps.id, target.id));
    }
    await tx
      .update(schema.tasks)
      .set({
        status: 'running',
        errorMessage: null,
        currentStepId: target.stepId,
        currentStepIndex: target.stepIndex,
        updatedAt: now,
      })
      .where(eq(schema.tasks.id, id));
    await tx.insert(schema.taskEvents).values({
      taskId: id,
      taskStepId: target.id,
      eventType: 'task.step_override',
      payload: { targetStepId: target.stepId, by: userId },
    });
  });

  await getTaskQueue().add(
    TASK_JOB_NAMES.ADVANCE_STEP,
    { taskId: id, userId, stepId: target.stepId } as TaskJobPayload,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );

  return c.json({ ok: true, currentStepId: target.stepId });
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
