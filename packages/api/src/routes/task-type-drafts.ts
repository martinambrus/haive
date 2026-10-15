import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { refusesNewWork } from '@haive/shared';
import {
  TYPE_DRAFT_MESSAGE_EVENT,
  TYPE_DRAFT_MESSAGE_MAX_CHARS,
  TYPE_DRAFT_STATE_MAX_BYTES,
  pickTaskTypeDraft,
} from '@haive/shared/modularity';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import { loadUsableProvider } from '../lib/step-cli-choice.js';
import { enqueueStart, markQueuedForStart } from '../lib/task-start.js';
import { definitionForCreate } from '../lib/task-type-definition.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { appendTaskEvent } from './tasks/_helpers.js';

const startSchema = z.object({
  message: z.string().trim().min(1).max(TYPE_DRAFT_MESSAGE_MAX_CHARS),
  cliProviderId: z.string().uuid().optional(),
  current: z
    .record(z.string(), z.unknown())
    .refine(
      (state) => Buffer.byteLength(JSON.stringify(state), 'utf8') <= TYPE_DRAFT_STATE_MAX_BYTES,
      'The editor state is too large',
    )
    .optional(),
  editingSlug: z.string().optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const NOT_FOUND = 'Draft conversation not found';

function toTurn(payload: unknown) {
  if (!isRecord(payload)) return null;
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (payload.role === 'user') {
    return {
      role: 'user' as const,
      body,
      ...(isRecord(payload.draft) ? { draft: payload.draft } : {}),
      ...(payload.draftIgnored === 'not-json' || payload.draftIgnored === 'too-large'
        ? { draftIgnored: payload.draftIgnored }
        : {}),
    };
  }
  if (payload.role !== 'assistant') return null;
  return {
    role: 'assistant' as const,
    body,
    draft: isRecord(payload.draft) ? payload.draft : null,
    issues: list(payload.issues),
    warnings: list(payload.warnings),
    dropped: list(payload.dropped),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
    ...(payload.repaired === true ? { repaired: true as const } : {}),
  };
}

export const taskTypeDraftRoutes = new Hono<AppEnv>();
taskTypeDraftRoutes.use('*', requireAuth);
taskTypeDraftRoutes.use('*', requireAdmin);

taskTypeDraftRoutes.post('/', async (c) => {
  const userId = c.get('userId');
  if (refusesNewWork(c.get('maintenanceState'))) {
    throw new HttpError(
      503,
      'Haive is preparing for maintenance, so new tasks are not being started. Work already ' +
        'running will finish.',
    );
  }
  const body = startSchema.parse(await c.req.json());
  const db = getDb();
  if (body.cliProviderId) await loadUsableProvider(db, userId, body.cliProviderId);
  if (body.editingSlug !== undefined) {
    const edited = await db.query.taskTypeDefinitions.findFirst({
      where: eq(schema.taskTypeDefinitions.slug, body.editingSlug),
      columns: { slug: true },
    });
    if (!edited) throw new HttpError(400, `Unknown task type ${body.editingSlug}`);
  }
  const { draft } = pickTaskTypeDraft(body.current ?? {});

  // The opening message is written before the start is queued: the step reads it on its first detect.
  const { taskId, queued } = await db.transaction(async (tx) => {
    const { runListSnapshot, customSteps } = await definitionForCreate(tx, 'type_draft', {
      generic: false,
    });
    const [task] = await tx
      .insert(schema.tasks)
      .values({
        userId,
        type: 'type_draft',
        title: 'Draft a task type',
        description: body.message,
        repositoryId: null,
        cliProviderId: body.cliProviderId ?? null,
        ignoreSavedStepClis: body.cliProviderId !== undefined,
        metadata: {
          anchorRepositoryId: null,
          egress: { mode: 'none', domains: [], ips: [] },
          ...(body.editingSlug !== undefined ? { editingSlug: body.editingSlug } : {}),
        },
        autoContinue: true,
        runListSnapshot,
        customSteps,
        status: 'created',
      })
      .returning({ id: schema.tasks.id });
    if (!task) throw new HttpError(500, 'Failed to create the draft conversation');
    await appendTaskEvent(tx, task.id, null, TYPE_DRAFT_MESSAGE_EVENT, {
      role: 'user',
      body: body.message,
      ...(Object.keys(draft).length > 0 ? { draft } : {}),
    });
    return { taskId: task.id, queued: await markQueuedForStart(tx, task.id) };
  });

  if (queued) await enqueueStart(taskId, userId);
  await recordAuditEvent(db, {
    actorUserId: userId,
    action: 'task_type_draft.start',
    targetType: 'task',
    targetId: taskId,
    metadata: {
      cliProviderId: body.cliProviderId ?? null,
      withEditorState: Object.keys(draft).length > 0,
    },
  });
  return c.json({ taskId }, 201);
});

taskTypeDraftRoutes.get('/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  if (!z.string().uuid().safeParse(taskId).success) throw new HttpError(404, NOT_FOUND);
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(
      eq(schema.tasks.id, taskId),
      eq(schema.tasks.userId, c.get('userId')),
      eq(schema.tasks.type, 'type_draft'),
    ),
    columns: { status: true },
  });
  if (!task) throw new HttpError(404, NOT_FOUND);
  const step = await db.query.taskSteps.findFirst({
    where: eq(schema.taskSteps.taskId, taskId),
    columns: { status: true, waitingStartedAt: true },
    orderBy: desc(schema.taskSteps.round),
  });
  const rows = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, TYPE_DRAFT_MESSAGE_EVENT),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  const turns = rows.flatMap(({ payload }) => toTurn(payload) ?? []);
  const latest = turns.findLast((turn) => turn.role === 'assistant' && turn.draft !== null);
  return c.json({
    status: task.status,
    awaitingMessage: step?.status === 'waiting_form' && step.waitingStartedAt !== null,
    turns,
    latestDraft: latest?.draft ?? null,
  });
});
