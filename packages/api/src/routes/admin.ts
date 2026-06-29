import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_CONCURRENCY_CHANNEL,
  CONFIG_KEYS,
  configService,
  decryptEmail,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  logger,
} from '@haive/shared';
import { getDb } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { recordAuditEvent } from '../lib/audit.js';

const log = logger.child({ module: 'admin' });

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use('*', requireAuth);
adminRoutes.use('*', requireAdmin);

const userActionSchema = z.object({
  action: z.enum(['deactivate', 'activate', 'reset_password', 'set_role']),
  role: z.enum(['admin', 'user']).optional(),
});

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

export function generateTemporaryPassword(length = 24): string {
  if (length < 12) {
    throw new Error('temporary password length must be >= 12');
  }
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    const idx = byte % PASSWORD_ALPHABET.length;
    out += PASSWORD_ALPHABET[idx];
  }
  return out;
}

adminRoutes.get('/users', async (c) => {
  const db = getDb();
  const fieldKey = await configService.getEncryptionKey();
  const rows = await db
    .select({
      id: schema.users.id,
      emailEncrypted: schema.users.emailEncrypted,
      role: schema.users.role,
      status: schema.users.status,
      tokenVersion: schema.users.tokenVersion,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
    })
    .from(schema.users)
    .orderBy(desc(schema.users.createdAt));

  const users = rows.map((row) => ({
    id: row.id,
    email: decryptEmail(row.emailEncrypted, fieldKey),
    role: row.role,
    status: row.status,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return c.json({ users });
});

// Audit log viewer: paginated + filterable read over the append-only
// audit_events trail. Actor email is joined from users (LEFT JOIN — null for a
// since-deleted user; the audit row itself has no FK and survives).
adminRoutes.get('/audit', async (c) => {
  const db = getDb();
  const q = c.req.query();

  const action = q.action || undefined;
  const targetType = q.targetType || undefined;
  const actorUserId = q.actorUserId || undefined;
  const fromDate = q.from ? new Date(q.from) : undefined;
  const toDate = q.to ? new Date(q.to) : undefined;
  const limit = Math.min(200, Math.max(1, Number.parseInt(q.limit ?? '50', 10) || 50));
  const offset = Math.max(0, Number.parseInt(q.offset ?? '0', 10) || 0);

  const conditions: SQL[] = [];
  if (action) conditions.push(eq(schema.auditEvents.action, action));
  if (targetType) conditions.push(eq(schema.auditEvents.targetType, targetType));
  if (actorUserId) conditions.push(eq(schema.auditEvents.actorUserId, actorUserId));
  if (fromDate && !Number.isNaN(fromDate.getTime()))
    conditions.push(gte(schema.auditEvents.createdAt, fromDate));
  if (toDate && !Number.isNaN(toDate.getTime()))
    conditions.push(lte(schema.auditEvents.createdAt, toDate));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: schema.auditEvents.id,
      actorUserId: schema.auditEvents.actorUserId,
      actorEmailEncrypted: schema.users.emailEncrypted,
      action: schema.auditEvents.action,
      targetType: schema.auditEvents.targetType,
      targetId: schema.auditEvents.targetId,
      metadata: schema.auditEvents.metadata,
      createdAt: schema.auditEvents.createdAt,
    })
    .from(schema.auditEvents)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditEvents.actorUserId))
    .where(where)
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.auditEvents)
    .where(where);
  const total = countRows[0]?.count ?? 0;

  const fieldKey = await configService.getEncryptionKey();
  const events = rows.map((r) => ({
    id: r.id,
    actorUserId: r.actorUserId,
    actorEmail: r.actorEmailEncrypted ? decryptEmail(r.actorEmailEncrypted, fieldKey) : null,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  }));

  // Distinct values for the filter dropdowns (data-driven, so new action types
  // appear without a code change). Cheap — both columns are indexed.
  const [actionFacets, typeFacets] = await Promise.all([
    db
      .selectDistinct({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .orderBy(schema.auditEvents.action),
    db
      .selectDistinct({ targetType: schema.auditEvents.targetType })
      .from(schema.auditEvents)
      .orderBy(schema.auditEvents.targetType),
  ]);

  return c.json({
    events,
    total,
    facets: {
      actions: actionFacets.map((r) => r.action),
      targetTypes: typeFacets.map((r) => r.targetType),
    },
  });
});

adminRoutes.post('/users/:id/action', async (c) => {
  const targetUserId = c.req.param('id');
  const callerUserId = c.get('userId');
  const body = userActionSchema.parse(await c.req.json());
  const db = getDb();

  const target = await db.query.users.findFirst({
    where: eq(schema.users.id, targetUserId),
    columns: {
      id: true,
      role: true,
      status: true,
      tokenVersion: true,
    },
  });
  if (!target) throw new HttpError(404, 'User not found');

  const now = new Date();

  if (body.action === 'deactivate') {
    if (target.id === callerUserId) {
      throw new HttpError(400, 'Cannot deactivate the calling admin');
    }
    await db
      .update(schema.users)
      .set({
        status: 'deactivated',
        tokenVersion: target.tokenVersion + 1,
        updatedAt: now,
      })
      .where(eq(schema.users.id, targetUserId));
    await recordAuditEvent(db, {
      actorUserId: callerUserId,
      action: 'user.deactivate',
      targetType: 'user',
      targetId: targetUserId,
    });
    return c.json({ ok: true, action: 'deactivate' });
  }

  if (body.action === 'activate') {
    await db
      .update(schema.users)
      .set({ status: 'active', updatedAt: now })
      .where(eq(schema.users.id, targetUserId));
    await recordAuditEvent(db, {
      actorUserId: callerUserId,
      action: 'user.activate',
      targetType: 'user',
      targetId: targetUserId,
    });
    return c.json({ ok: true, action: 'activate' });
  }

  if (body.action === 'reset_password') {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await db
      .update(schema.users)
      .set({
        passwordHash,
        tokenVersion: target.tokenVersion + 1,
        updatedAt: now,
      })
      .where(eq(schema.users.id, targetUserId));
    await recordAuditEvent(db, {
      actorUserId: callerUserId,
      action: 'user.reset_password',
      targetType: 'user',
      targetId: targetUserId,
    });
    return c.json({ ok: true, action: 'reset_password', temporaryPassword });
  }

  if (body.action === 'set_role') {
    if (!body.role) throw new HttpError(400, 'role required for set_role');
    if (target.id === callerUserId && body.role !== 'admin') {
      throw new HttpError(400, 'Cannot demote the calling admin');
    }
    await db
      .update(schema.users)
      .set({ role: body.role, updatedAt: now })
      .where(eq(schema.users.id, targetUserId));
    await recordAuditEvent(db, {
      actorUserId: callerUserId,
      action: 'user.set_role',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { role: body.role },
    });
    return c.json({ ok: true, action: 'set_role', role: body.role });
  }

  throw new HttpError(400, 'Unknown admin action');
});

adminRoutes.get('/health', async (c) => {
  const db = getDb();
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [userCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
      deactivated: sql<number>`count(*) filter (where status = 'deactivated')::int`,
      admins: sql<number>`count(*) filter (where role = 'admin')::int`,
    })
    .from(schema.users);

  const taskRows = await db
    .select({
      status: schema.tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.tasks)
    .groupBy(schema.tasks.status);

  const containerRows = await db
    .select({
      status: schema.containers.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.containers)
    .groupBy(schema.containers.status);

  const recentErrors = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, 'failed'), gte(schema.tasks.updatedAt, twentyFourHoursAgo)))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(25);

  return c.json({
    users: userCounts ?? { total: 0, active: 0, deactivated: 0, admins: 0 },
    tasks: Object.fromEntries(taskRows.map((r) => [r.status, r.count])),
    containers: Object.fromEntries(containerRows.map((r) => [r.status, r.count])),
    recentFailures: recentErrors.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
    })),
    timestamp: now.toISOString(),
  });
});

const concurrencySchema = z.object({
  // Floor of 1 (BullMQ needs concurrency >= 1); no upper limit — set per host.
  maxParallelAgents: z.number().int().min(1),
});

adminRoutes.get('/config/concurrency', async (c) => {
  const maxParallelAgents = await configService.getNumber(CONFIG_KEYS.MAX_PARALLEL_AGENTS, 3);
  return c.json({ maxParallelAgents });
});

adminRoutes.put('/config/concurrency', async (c) => {
  const { maxParallelAgents } = concurrencySchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.MAX_PARALLEL_AGENTS, String(maxParallelAgents));
  // Live-retune the worker's cli-exec queue concurrency without a restart.
  await configService.getRedis().publish(CONFIG_CONCURRENCY_CHANNEL, String(maxParallelAgents));
  log.info({ maxParallelAgents }, 'max parallel agents updated');
  return c.json({ maxParallelAgents });
});

const steeringSchema = z.object({ enabled: z.boolean() });

// Global mid-run steering kill-switch. The worker reads this at each cli dispatch
// (within the ~30s config cache), so no live-retune channel is needed.
adminRoutes.get('/config/steering', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.STEERING_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/steering', async (c) => {
  const { enabled } = steeringSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.STEERING_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global steering switch updated');
  return c.json({ enabled });
});

const browserAccessSchema = z.object({ enabled: z.boolean() });

// Global direct-browser-access kill-switch. The worker reads this at runner START
// (within the ~30s config cache); OFF stops new runners publishing a loopback host
// port, so a task reverts to VNC-only. A mid-task flip needs a runner restart.
adminRoutes.get('/config/browser-access', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/browser-access', async (c) => {
  const { enabled } = browserAccessSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, enabled ? 'true' : 'false');
  log.info({ enabled }, 'direct browser access switch updated');
  return c.json({ enabled });
});

const ideEnabledSchema = z.object({ enabled: z.boolean() });

// Global in-task IDE (Editor tab) kill-switch. The api/worker read this within the
// ~30s config cache; OFF hides the Editor tab and refuses new code-server launches
// (the read-only Source viewer remains the fallback). Persists across restarts.
adminRoutes.get('/config/ide', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.IDE_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/ide', async (c) => {
  const { enabled } = ideEnabledSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.IDE_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global ide switch updated');
  return c.json({ enabled });
});

const debugModeSchema = z.object({ enabled: z.boolean() });

// Global on-demand step-debugging kill-switch. The worker reads it in the
// 01-debug-mode step's shouldRun (within the ~30s config cache); OFF skips that step
// everywhere so tasks run with debug_mode off (no Xdebug / --inspect overhead).
// Persists across restarts.
adminRoutes.get('/config/debug-mode', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.DEBUG_MODE_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/debug-mode', async (c) => {
  const { enabled } = debugModeSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.DEBUG_MODE_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global debug-mode switch updated');
  return c.json({ enabled });
});

const fairSchedulingSchema = z.object({ enabled: z.boolean() });

// Global fair cli-exec scheduling kill-switch. The worker reads this at each
// enqueue (within the ~30s config cache), so no live-retune channel is needed.
adminRoutes.get('/config/fair-scheduling', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.FAIR_SCHEDULING_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/fair-scheduling', async (c) => {
  const { enabled } = fairSchedulingSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.FAIR_SCHEDULING_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'fair scheduling switch updated');
  return c.json({ enabled });
});

const maxAgentsPerTaskSchema = z.object({
  // Floor of 1; no upper limit. Caps how many CLI/agent invocations a single task
  // may run at once (read per job pickup within the ~30s config cache).
  maxAgentsPerTask: z.number().int().min(1),
});

adminRoutes.get('/config/max-agents-per-task', async (c) => {
  const maxAgentsPerTask = await configService.getNumber(
    CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK,
    5,
  );
  return c.json({ maxAgentsPerTask });
});

adminRoutes.put('/config/max-agents-per-task', async (c) => {
  const { maxAgentsPerTask } = maxAgentsPerTaskSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.MAX_PARALLEL_AGENTS_PER_TASK, String(maxAgentsPerTask));
  log.info({ maxAgentsPerTask }, 'max agents per task updated');
  return c.json({ maxAgentsPerTask });
});

const attachmentMaxBytesSchema = z.object({
  // Floor 1 KiB; no hard upper limit (host disk bounds it). Per-file cap for task
  // attachments, read by the upload endpoint within the ~30s config cache.
  maxBytes: z.number().int().min(1024),
});

adminRoutes.get('/config/attachment-max-bytes', async (c) => {
  const maxBytes = await configService.getNumber(
    CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES,
    DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  );
  return c.json({ maxBytes });
});

adminRoutes.put('/config/attachment-max-bytes', async (c) => {
  const { maxBytes } = attachmentMaxBytesSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES, String(maxBytes));
  log.info({ maxBytes }, 'task attachment max bytes updated');
  return c.json({ maxBytes });
});
