import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
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

// Merges a cancelled task left open. Auth + task ownership come from the parent taskRoutes
// (requireAuth + userId), mirroring browser-access.ts. The abort runs in the worker: the api
// never spawns git.

export const mergeRoutes = new Hono<AppEnv>();

const abortBody = z.object({ dir: z.string().min(1) });

mergeRoutes.post('/:id/merges/abort', async (c) => {
  const userId = c.get('userId');
  const taskId = c.req.param('id');
  const parsed = abortBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, 'dir is required');
  const { dir } = parsed.data;

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
  if (!leftOpenMerges(events).some((m) => m.dir === dir && m.settled === null)) {
    throw new HttpError(404, 'No open merge is reported for that directory');
  }

  await getTaskQueue().add(
    TASK_JOB_NAMES.ABORT_LEFT_MERGE,
    { taskId, userId, dir } satisfies AbortLeftMergePayload,
    {
      jobId: `abort-left-merge-${taskId}-${createHash('sha1').update(dir).digest('hex')}`,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
  return c.json({ queued: true }, 202);
});
