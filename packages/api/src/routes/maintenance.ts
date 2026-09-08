import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  logger,
  maintenanceStateSchema,
  parseMaintenanceState,
} from '@haive/shared';
import { getDb } from '../db.js';
import { recordAuditEvent } from '../lib/audit.js';
import { clearTaskPause, stopActiveCliInvocations } from '../lib/task-control.js';
import { appendTaskEvent } from './tasks/_helpers.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'maintenance' });

/**
 * Operator control for a maintenance window: set the state, see whose work is blocking it, and
 * act on that work.
 *
 * Self-applying auth, like every other router here. Admin-only throughout — this is the first
 * surface in Haive that can touch another user's tasks at all.
 */
export const maintenanceRoutes = new Hono<AppEnv>();
maintenanceRoutes.use('*', requireAuth);
maintenanceRoutes.use('*', requireAdmin);

/** Task states that still hold a maintenance window open. `waiting_user` counts: a task parked on
 *  a form is live work whose owner will come back to it, and stopping it loses their place. */
const LIVE_TASK_STATES = [
  'created',
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_pr',
] as const;

const setStateSchema = z.object({ state: maintenanceStateSchema });

maintenanceRoutes.get('/', async (c) => {
  const state = parseMaintenanceState(await configService.get(CONFIG_KEYS.MAINTENANCE_STATE));
  return c.json({ state });
});

maintenanceRoutes.put('/', async (c) => {
  const { state } = setStateSchema.parse(await c.req.json());
  const previous = parseMaintenanceState(await configService.get(CONFIG_KEYS.MAINTENANCE_STATE));
  await configService.set(CONFIG_KEYS.MAINTENANCE_STATE, state);
  await recordAuditEvent(getDb(), {
    actorUserId: c.get('userId'),
    action: 'maintenance.set_state',
    targetType: 'system',
    metadata: { from: previous, to: state },
  });
  log.info({ from: previous, to: state }, 'maintenance state changed');
  return c.json({ state, previous });
});

/**
 * What is still holding the window open.
 *
 * Names the OWNER, not just the task. An admin who can see "3 tasks are running" can only guess;
 * one who can see whose they are can go and ask, which is the difference between a drain that
 * finishes and a drain that gets forced.
 */
maintenanceRoutes.get('/blocking', async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      type: schema.tasks.type,
      status: schema.tasks.status,
      pausedAt: schema.tasks.pausedAt,
      currentStepId: schema.tasks.currentStepId,
      updatedAt: schema.tasks.updatedAt,
      ownerId: schema.users.id,
      ownerName: schema.users.name,
    })
    .from(schema.tasks)
    .leftJoin(schema.users, eq(schema.users.id, schema.tasks.userId))
    .where(inArray(schema.tasks.status, [...LIVE_TASK_STATES]))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(200);

  // A task with a live CLI is the one a drain actually has to wait for; a parked one is only
  // holding a slot. Surfaced separately so the operator can tell "still working" from "waiting".
  const live = await db
    .select({ taskId: schema.cliInvocations.taskId })
    .from(schema.cliInvocations)
    .where(and(isNull(schema.cliInvocations.endedAt), isNull(schema.cliInvocations.supersededAt)));
  const withLiveCli = new Set(live.map((r) => r.taskId));

  return c.json({
    tasks: rows.map((r) => ({ ...r, hasLiveCli: withLiveCli.has(r.id) })),
    total: rows.length,
    // The listing is capped; say so rather than letting an operator read a truncated list as the
    // whole picture and force a drain that still had work behind it.
    capped: rows.length === 200,
  });
});

const taskActionSchema = z.object({ action: z.enum(['pause', 'resume', 'stop']) });

/**
 * Act on ANY user's task, for a drain.
 *
 * A separate route rather than relaxing the ownership predicate on `POST /tasks/:id/action`.
 * Widening that handler would broaden every read and write sharing it, so a future slip in the
 * role check becomes cross-tenant access; a distinct route behind `requireAdmin` is explicit and
 * greppable. Same reasoning `routes/system.ts` already writes down for the global pause: everyone
 * may READ the state, flipping it stays on the admin route.
 *
 * `cancel` is deliberately absent. A drain needs work HELD or its CLI stopped, never destroyed,
 * and a destructive cross-user action added for a case that does not need one is permanent blast
 * radius. `stop` here is kill-the-CLI-keep-the-environment — the task stays restartable.
 */
maintenanceRoutes.post('/tasks/:id/action', async (c) => {
  const actorUserId = c.get('userId');
  const taskId = c.req.param('id');
  const { action } = taskActionSchema.parse(await c.req.json());
  const db = getDb();

  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { id: true, userId: true, status: true, pausedAt: true },
  });
  if (!task) throw new HttpError(404, 'Task not found');

  // Two logs, because they have two audiences. The audit row is the security trail an admin can
  // query; the task event is what the OWNER sees on their own task page, so they learn who
  // stopped their work and why rather than finding it mysteriously halted.
  const audit = async (metadata: Record<string, unknown>) => {
    await recordAuditEvent(db, {
      actorUserId,
      action: `task.admin_${action}`,
      targetType: 'task',
      targetId: taskId,
      metadata: { ownerUserId: task.userId, ...metadata },
    });
  };

  switch (action) {
    case 'pause': {
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new HttpError(409, `Cannot pause a ${task.status} task`);
      }
      // Idempotent, and it keeps the ORIGINAL timestamp for the same reason the owner path does:
      // that stamp anchors the runtime reaper's paused-grace.
      if (task.pausedAt) return c.json({ ok: true, pausedAt: task.pausedAt.toISOString() });
      const pausedAt = new Date();
      await db
        .update(schema.tasks)
        .set({ pausedAt, updatedAt: pausedAt })
        .where(eq(schema.tasks.id, taskId));
      await appendTaskEvent(db, taskId, null, 'task.paused', {
        by: actorUserId,
        byAdmin: true,
        reason: 'maintenance',
      });
      await audit({ pausedAt: pausedAt.toISOString() });
      return c.json({ ok: true, pausedAt: pausedAt.toISOString() });
    }
    case 'resume': {
      if (!task.pausedAt) return c.json({ ok: true, pausedAt: null });
      await clearTaskPause(db, taskId);
      await appendTaskEvent(db, taskId, null, 'task.resumed', { by: actorUserId, byAdmin: true });
      await audit({});
      return c.json({ ok: true, pausedAt: null });
    }
    case 'stop': {
      const result = await stopActiveCliInvocations(db, taskId, {
        failTask: true,
        actor: 'admin',
      });
      await appendTaskEvent(db, taskId, null, 'task.stopped', {
        by: actorUserId,
        byAdmin: true,
        reason: 'maintenance',
        ...result,
      });
      await audit(result);
      log.info({ taskId, ...result }, 'admin stopped a task for maintenance');
      return c.json({ ok: true, ...result });
    }
  }
});
