import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ROOT_CLAIM_STALE_MS, schema } from '@haive/database';
import {
  leftOpenMerges,
  MERGE_LEFT_OPEN_EVENT,
  MERGE_LEFT_OPEN_SETTLED_EVENT,
  TASK_JOB_NAMES,
  type AbortLeftMergePayload,
} from '@haive/shared';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';
import { getTaskQueue } from '../../queues.js';
import { addOrRefuse } from '../../lib/queue-bounded.js';
import {
  leftCommittedMerges,
  MERGE_LEFT_COMMITTED_EVENT,
  MERGE_LEFT_COMMITTED_SETTLED_EVENT,
} from '@haive/shared/merge-left-open';
import type { UndoLeftMergePayload } from '@haive/shared';

// Merges a cancelled task left open. Auth + task ownership come from the parent taskRoutes
// (requireAuth + userId), mirroring browser-access.ts. The abort runs in the worker: the api
// never spawns git.

export const mergeRoutes = new Hono<AppEnv>();

const abortBody = z.object({ dir: z.string().min(1), mergeHead: z.string().min(1) });

mergeRoutes.post('/:id/merges/abort', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const parsed = abortBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'dir and mergeHead are required');
  const { dir, mergeHead } = parsed.data;

  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true, status: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status !== 'cancelled') throw new HttpError(409, 'Only a cancelled task can abort this');

  const events = await db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [
          MERGE_LEFT_OPEN_EVENT,
          MERGE_LEFT_OPEN_SETTLED_EVENT,
        ]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  const open = leftOpenMerges(events).some(
    (m) => m.dir === dir && m.mergeHead === mergeHead && m.settled === null,
  );
  if (!open) {
    throw new HttpError(404, 'No open merge is reported for that directory');
  }

  await addOrRefuse(
    () =>
      getTaskQueue().add(
        TASK_JOB_NAMES.ABORT_LEFT_MERGE,
        { taskId, userId, dir, mergeHead } satisfies AbortLeftMergePayload,
        {
          jobId: `abort-left-merge-${taskId}-${createHash('sha1').update(`${dir}\0${mergeHead}`).digest('hex')}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      ),
    'abort left merge',
    { taskId },
  );
  return c.json({ queued: true }, 202);
});

const undoBody = z.object({
  dir: z.string().min(1),
  baseShaAfter: z.string().regex(/^[0-9a-f]{40}$/),
});

const UNDO_RETRY_DELAY_MS = 2000;
// A dead worker can leave a settled git move still owing projection recovery, with its root
// lease fresh. Keep a retry beyond that lease; refusal outcomes themselves need no retry.
const UNDO_ATTEMPTS = Math.ceil(Math.log2(ROOT_CLAIM_STALE_MS / UNDO_RETRY_DELAY_MS + 1)) + 1;

mergeRoutes.post('/:id/merges/undo', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const parsed = undoBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'dir and baseShaAfter are required');
  const { dir, baseShaAfter } = parsed.data;
  const db = getDb();
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true, status: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status !== 'cancelled')
    throw new HttpError(409, 'Only a cancelled task can undo this merge');
  const events = await db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [
          MERGE_LEFT_COMMITTED_EVENT,
          MERGE_LEFT_COMMITTED_SETTLED_EVENT,
        ]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  const target = leftCommittedMerges(events).find(
    (m) => m.dir === dir && m.baseShaAfter === baseShaAfter,
  );
  if (!target || target.settled)
    throw new HttpError(
      409,
      'No unsettled committed merge is reported for that directory and commit',
    );
  await addOrRefuse(
    () =>
      getTaskQueue().add(
        TASK_JOB_NAMES.UNDO_LEFT_MERGE,
        { taskId, userId, dir, baseShaAfter } satisfies UndoLeftMergePayload,
        {
          jobId: `undo-left-merge-${taskId}-${createHash('sha1').update(`${dir}\0${baseShaAfter}`).digest('hex')}`,
          attempts: UNDO_ATTEMPTS,
          backoff: { type: 'exponential', delay: UNDO_RETRY_DELAY_MS },
          removeOnComplete: true,
          removeOnFail: true,
        },
      ),
    'undo left merge',
    { taskId },
  );
  return c.json({ queued: true }, 202);
});
