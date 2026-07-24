import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Hono } from 'hono';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  ALLOWANCE_WATCH_MODES,
  CONFIG_CONCURRENCY_CHANNEL,
  CONFIG_KEYS,
  CONFIG_RUNTIME_LIMITS_CHANNEL,
  configService,
  decryptEmail,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  logger,
  parseAllowanceWatchMode,
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

const runtimeLimitsSchema = z.object({
  enabled: z.boolean(),
  // 0 = auto-derive from host RAM/CPU; a positive value overrides (deriveRuntimeCaps
  // re-clamps to a safe floor regardless).
  memoryMb: z.number().int().min(0),
  cpus: z.number().int().min(0),
  maxConcurrent: z.number().int().min(0),
  idleReapMinutes: z.number().int().min(0),
});

// Machine-aware runtime resource governor: master kill-switch, per-runner memory/CPU
// caps, the aggregate concurrent-runtime cap, and the leaked-runner reap grace. Any
// number at 0 auto-derives from host size. Caps are read at each runner START (~30s
// config cache); the concurrency cap + master switch are also published so the worker's
// admission gate retunes live.
adminRoutes.get('/config/runtime-limits', async (c) => {
  const [enabled, memoryMb, cpus, maxConcurrent, idleReapMinutes] = await Promise.all([
    configService.getBoolean(CONFIG_KEYS.RESOURCE_LIMITS_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.RUNTIME_MEMORY_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_CPUS, 0),
    configService.getNumber(CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES, 180),
  ]);
  return c.json({ enabled, memoryMb, cpus, maxConcurrent, idleReapMinutes });
});

adminRoutes.put('/config/runtime-limits', async (c) => {
  const body = runtimeLimitsSchema.parse(await c.req.json());
  await Promise.all([
    configService.set(CONFIG_KEYS.RESOURCE_LIMITS_ENABLED, body.enabled ? 'true' : 'false'),
    configService.set(CONFIG_KEYS.RUNTIME_MEMORY_MB, String(body.memoryMb)),
    configService.set(CONFIG_KEYS.RUNTIME_CPUS, String(body.cpus)),
    configService.set(CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES, String(body.maxConcurrent)),
    configService.set(CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES, String(body.idleReapMinutes)),
  ]);
  // Retune the admission gate live (new max / master switch); per-container caps re-read
  // at the next runner start within the config cache.
  await configService.getRedis().publish(CONFIG_RUNTIME_LIMITS_CHANNEL, String(body.maxConcurrent));
  log.info({ ...body }, 'runtime resource limits updated');
  return c.json({ ...body });
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

const prWorkflowSchema = z.object({ enabled: z.boolean() });

// Global master switch for the create-PR close-out workflow. Gates step 12's create_pr
// option, the 13-pr-wait park, and the PR-status poller. Default off (staged rollout);
// the per-repo pr_workflow_enabled toggle sits under this master switch. Read within the
// ~30s config cache, so a flip applies to the next task/poll tick.
adminRoutes.get('/config/pr-workflow', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.PR_WORKFLOW_ENABLED, false);
  return c.json({ enabled });
});

adminRoutes.put('/config/pr-workflow', async (c) => {
  const { enabled } = prWorkflowSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.PR_WORKFLOW_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global PR-workflow switch updated');
  return c.json({ enabled });
});

const softTimeoutSchema = z.object({
  enabled: z.boolean(),
  // 1..99: at 0 the wind-down lands before the CLI reads anything, at 100 after the
  // SIGKILL. Integer because configService.getNumber parses with parseInt.
  percent: z.number().int().min(1).max(99),
});

// Soft timeout before the hard SIGKILL, for steerable (Claude-family) invocations.
// At `percent` of the invocation's timeout budget the worker steers the CLI to stop
// investigating and emit its verified findings. Read once per invocation at spawn
// (within the ~30s config cache), so a flip applies to the next invocation, not the
// running one.
adminRoutes.get('/config/cli-soft-timeout', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.CLI_SOFT_TIMEOUT_ENABLED, true);
  const percent = await configService.getNumber(CONFIG_KEYS.CLI_SOFT_TIMEOUT_PERCENT, 80);
  return c.json({ enabled, percent });
});

adminRoutes.put('/config/cli-soft-timeout', async (c) => {
  const { enabled, percent } = softTimeoutSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.CLI_SOFT_TIMEOUT_ENABLED, enabled ? 'true' : 'false');
  await configService.set(CONFIG_KEYS.CLI_SOFT_TIMEOUT_PERCENT, String(percent));
  log.info({ enabled, percent }, 'cli soft timeout updated');
  return c.json({ enabled, percent });
});

const usageWindowSchema = z.object({ enabled: z.boolean() });

// Global kill-switch for the subscription usage-window display. When ON (default),
// the worker's gentle poller refreshes each logged-in provider's 5h/weekly meters
// and the task header shows the active step's CLI windows. The poller reads this
// each tick (within the ~30s config cache); a flip needs no redeploy.
adminRoutes.get('/config/usage-window', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.USAGE_WINDOW_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/usage-window', async (c) => {
  const { enabled } = usageWindowSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.USAGE_WINDOW_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global usage-window switch updated');
  return c.json({ enabled });
});

const usageAlertSchema = z.object({
  enabled: z.boolean(),
  // REMAINING percent, not consumed. 1..50: at 0 the alert could never fire, and past
  // half a window it stops being a warning. Integer because configService.getNumber
  // parses with parseInt.
  thresholdPct: z.number().int().min(1).max(50),
});

// Subscription usage-depletion alerts: the global enable plus the remaining-% threshold
// at which the web notifier warns (once per provider per window per reset). The per-user
// opt-out lives on user_notification_settings; GET /usage-window folds all three together
// so the notifier needs a single fetch. Read within the ~30s config cache; no redeploy.
adminRoutes.get('/config/usage-alert', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.USAGE_ALERT_ENABLED, true);
  const thresholdPct = await configService.getNumber(CONFIG_KEYS.USAGE_ALERT_THRESHOLD_PCT, 10);
  return c.json({ enabled, thresholdPct });
});

adminRoutes.put('/config/usage-alert', async (c) => {
  const { enabled, thresholdPct } = usageAlertSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.USAGE_ALERT_ENABLED, enabled ? 'true' : 'false');
  await configService.set(CONFIG_KEYS.USAGE_ALERT_THRESHOLD_PCT, String(thresholdPct));
  log.info({ enabled, thresholdPct }, 'usage alert config updated');
  return c.json({ enabled, thresholdPct });
});

const promptCaching1hSchema = z.object({ enabled: z.boolean() });

// Global 1-hour prompt-cache TTL opt-in (default OFF). When ON, claude-family cli-exec
// invocations set ENABLE_PROMPT_CACHING_1H=1 so API-key/Bedrock/Vertex runs use the 1h
// cache TTL (subscription auth is already 1h). 1h cache write costs 2x base input vs the
// 5-min default's 1.25x, so leave OFF unless steps reuse the prefix within the hour. The
// worker reads it per cli dispatch (~30s config cache); no redeploy needed.
adminRoutes.get('/config/prompt-caching-1h', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.PROMPT_CACHING_1H, false);
  return c.json({ enabled });
});

adminRoutes.put('/config/prompt-caching-1h', async (c) => {
  const { enabled } = promptCaching1hSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.PROMPT_CACHING_1H, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global prompt-caching-1h switch updated');
  return c.json({ enabled });
});

const tersenessSchema = z.object({ level: z.enum(['lite', 'full', 'ultra']) });

// Global output terseness level (lite | full | ultra; default full). Appended as a
// prose-only style directive to each CLI step's main prompt — structured output, code,
// and specs are carved out, and reasoning is untouched. The worker reads it per cli
// dispatch (~30s config cache); a change needs no redeploy.
adminRoutes.get('/config/terseness', async (c) => {
  const level = (await configService.get(CONFIG_KEYS.TERSENESS_LEVEL)) ?? 'full';
  return c.json({ level });
});

adminRoutes.put('/config/terseness', async (c) => {
  const { level } = tersenessSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.TERSENESS_LEVEL, level);
  log.info({ level }, 'global terseness level updated');
  return c.json({ level });
});

const reviewFanoutDistillSchema = z.object({ enabled: z.boolean() });

// Opt-in (default off): condense the spec passed to the 08c code-review fan-out (full
// spec written to a worktree artifact reviewers can Read). The worker reads it in 08c
// detect per task; a change needs no redeploy.
adminRoutes.get('/config/review-fanout-distill', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.REVIEW_FANOUT_DISTILL, false);
  return c.json({ enabled });
});

adminRoutes.put('/config/review-fanout-distill', async (c) => {
  const { enabled } = reviewFanoutDistillSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.REVIEW_FANOUT_DISTILL, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global review-fanout-distill switch updated');
  return c.json({ enabled });
});

const reviewRefuteSchema = z.object({ enabled: z.boolean() });

// Refutation pass over blocking code-review findings (default ON). A blocking finding
// costs one of the capped fix rounds, so a refuter is asked to disprove it first; only
// positive, cited evidence dismisses it. The worker reads this per 08c apply (~30s config
// cache), so a flip applies to the next review, not a running one.
adminRoutes.get('/config/review-refute', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.REVIEW_REFUTE_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/review-refute', async (c) => {
  const { enabled } = reviewRefuteSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.REVIEW_REFUTE_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'global review-refute switch updated');
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

const dbAccessSchema = z.object({ enabled: z.boolean() });

// Global direct-database-access kill-switch. The worker reads it at runner START
// (the loopback db-port reservation) and per bring-up (the socat listener), within
// the ~30s config cache; OFF stops new runners reserving the db port and refuses the
// per-task opt-in everywhere, so no task can expose its database. A mid-task flip
// needs a runner restart to change the reservation. Persists across restarts.
adminRoutes.get('/config/db-access', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.DB_DIRECT_ACCESS, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/db-access', async (c) => {
  const { enabled } = dbAccessSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.DB_DIRECT_ACCESS, enabled ? 'true' : 'false');
  log.info({ enabled }, 'direct database access switch updated');
  return c.json({ enabled });
});

const ddevRegistryCacheSchema = z.object({ enabled: z.boolean() });

// Global DDEV image pull-through cache kill-switch. The worker reads this at runner
// START (within the ~30s config cache); OFF stops new runners routing their nested
// dockerd Hub pulls through the shared registry mirror (they pull direct from Docker
// Hub). A mid-task flip needs Stop/Retry. Persists across restarts.
adminRoutes.get('/config/ddev-registry-cache', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.DDEV_REGISTRY_CACHE_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/ddev-registry-cache', async (c) => {
  const { enabled } = ddevRegistryCacheSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.DDEV_REGISTRY_CACHE_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'ddev registry cache switch updated');
  return c.json({ enabled });
});

const allowanceWatchSchema = z.object({ mode: z.enum(ALLOWANCE_WATCH_MODES) });

// Global provider-outage watch level. 'off' stops monitoring entirely (nothing is armed when
// a task fails on a provider rate-limit or 5xx); 'notify' (default) watches and fires a
// browser notification once the provider is back; 'auto' additionally re-runs the failed step
// (resume semantics, capped). Read per poll tick and at arm time, within the ~30s config
// cache. The stored key keeps its legacy boolean name — see CONFIG_KEYS.ALLOWANCE_WATCH_MODE.
adminRoutes.get('/config/allowance-watch', async (c) => {
  const mode = parseAllowanceWatchMode(await configService.get(CONFIG_KEYS.ALLOWANCE_WATCH_MODE));
  return c.json({ mode });
});

adminRoutes.put('/config/allowance-watch', async (c) => {
  const { mode } = allowanceWatchSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.ALLOWANCE_WATCH_MODE, mode);
  log.info({ mode }, 'provider-outage watch mode updated');
  return c.json({ mode });
});

const ddevControlSchema = z.object({ enabled: z.boolean() });

// Global ddev-control MCP kill-switch. When ON (default), a DDEV task's AI CLI gets the
// ddev-control MCP (ddev_status / ddev_logs / ddev_restart) so it can inspect and recover
// its OWN runner when the app 404s. The worker reads this at cli-exec build time (within
// the ~30s config cache); OFF stops injecting the server everywhere. Persists across restarts.
adminRoutes.get('/config/ddev-control', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED, true);
  return c.json({ enabled });
});

adminRoutes.put('/config/ddev-control', async (c) => {
  const { enabled } = ddevControlSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.DDEV_CONTROL_MCP_ENABLED, enabled ? 'true' : 'false');
  log.info({ enabled }, 'ddev-control MCP switch updated');
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
