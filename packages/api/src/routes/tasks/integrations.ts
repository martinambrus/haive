import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { listIntegrationProviders, resolveTaskCategories } from '@haive/shared/integrations';
import { getDb, type Database } from '../../db.js';
import {
  removePreference,
  requireFitsRepository,
  requireValidChoice,
  upsertPreference,
} from '../../lib/integration-choice.js';
import { refuseDeadTask } from '../../lib/task-dead.js';
import { HttpError, type AppEnv } from '../../context.js';
import { appendTaskEvent } from './_helpers.js';

const CHOICE_EVENT = 'task.integration_choice_changed';

const choiceSchema = z.object({
  providerId: z.string().min(1).max(256),
  connectionId: z.string().uuid().nullish(),
  remember: z.boolean().optional(),
});

export const taskIntegrationRoutes = new Hono<AppEnv>();

async function requireOwnTask(db: Database, taskId: string, userId: string) {
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { id: true, status: true, repositoryId: true, deadAt: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');
  return task;
}

async function requireChangeableTask(db: Database, taskId: string, userId: string) {
  const task = await requireOwnTask(db, taskId, userId);
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new HttpError(409, `Cannot change integrations for ${task.status} task`);
  }
  refuseDeadTask(task);
  return task;
}

taskIntegrationRoutes.get('/:id/integrations', async (c) => {
  const db = getDb();
  const task = await requireOwnTask(db, c.req.param('id'), c.get('userId'));
  const chosen = await db
    .select({ categoryId: schema.taskIntegrationChoices.categoryId })
    .from(schema.taskIntegrationChoices)
    .where(eq(schema.taskIntegrationChoices.taskId, task.id));
  const categories = new Set([
    ...listIntegrationProviders().flatMap((provider) => provider.categories),
    ...chosen.map((choice) => choice.categoryId),
  ]);
  return c.json({
    categories: await resolveTaskCategories(db, {
      taskId: task.id,
      categories: [...categories].sort(),
    }),
  });
});

taskIntegrationRoutes.put('/:id/integrations/:categoryId', async (c) => {
  const userId = c.get('userId');
  const categoryId = c.req.param('categoryId');
  const body = choiceSchema.parse(await c.req.json());
  const pick = { categoryId, providerId: body.providerId, connectionId: body.connectionId ?? null };
  const remember = body.remember === true;
  const db = getDb();

  const task = await requireChangeableTask(db, c.req.param('id'), userId);
  const connection = await requireValidChoice(db, userId, pick);
  await requireFitsRepository(db, categoryId, connection, task.repositoryId);

  await db.transaction(async (tx) => {
    await tx
      .insert(schema.taskIntegrationChoices)
      .values({ taskId: task.id, ...pick })
      .onConflictDoUpdate({
        target: [schema.taskIntegrationChoices.taskId, schema.taskIntegrationChoices.categoryId],
        set: {
          providerId: pick.providerId,
          connectionId: pick.connectionId,
          updatedAt: new Date(),
        },
      });
    if (remember) await upsertPreference(tx, { userId, ...pick });
    await appendTaskEvent(tx, task.id, null, CHOICE_EVENT, {
      ...pick,
      remembered: remember,
      by: userId,
    });
  });
  return c.json(pick);
});

taskIntegrationRoutes.delete('/:id/integrations/:categoryId', async (c) => {
  const userId = c.get('userId');
  const categoryId = c.req.param('categoryId');
  const remember = c.req.query('remember') === '1';
  const db = getDb();

  const task = await requireChangeableTask(db, c.req.param('id'), userId);

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.taskIntegrationChoices)
      .where(
        and(
          eq(schema.taskIntegrationChoices.taskId, task.id),
          eq(schema.taskIntegrationChoices.categoryId, categoryId),
        ),
      );
    await tx
      .delete(schema.integrationGrants)
      .where(
        and(
          eq(schema.integrationGrants.targetKind, 'task'),
          eq(schema.integrationGrants.taskId, task.id),
          eq(schema.integrationGrants.categoryId, categoryId),
        ),
      );
    if (remember) await removePreference(tx, userId, categoryId);
    await appendTaskEvent(tx, task.id, null, CHOICE_EVENT, {
      categoryId,
      providerId: null,
      connectionId: null,
      remembered: remember,
      by: userId,
    });
  });
  return c.json({ ok: true });
});
