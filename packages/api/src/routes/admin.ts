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
  DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS,
  DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
  DEFAULT_CLI_TIMEOUT_LADDER,
  DEFAULT_TASK_ATTACHMENT_MAX_BYTES,
  deriveAgentConcurrency,
  deriveAgentSafetyMb,
  deriveRuntimeCaps,
  logger,
  parseAllowanceWatchMode,
  parseTimeoutLadder,
  readHostAvailableMb,
  readHostResources,
  TERSENESS_LEVELS,
  DISPLAY_CURRENCIES,
  isDisplayCurrency,
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
  // Rejection sampling. The alphabet is 65 chars, which does not divide 256, so
  // a bare `byte % 65` would hand the first 61 characters a 4/256 chance and the
  // last 4 only 3/256. Discarding bytes at or above the largest multiple of the
  // alphabet length keeps every character equally likely.
  const limit = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
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
  // 0 = auto (sized from the host budget the runtime pool leaves free); a positive value pins
  // it, with no upper limit — set per host.
  maxParallelAgents: z.number().int().min(0),
});

adminRoutes.get('/config/concurrency', async (c) => {
  const maxParallelAgents = await configService.getNumber(CONFIG_KEYS.MAX_PARALLEL_AGENTS, 0);
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
  // Planning weights, NOT container caps: what the admission gate assumes each consumer
  // occupies out of the host budget. Lowering them is what buys concurrency.
  ddevWeightMb: z.number().int().min(0),
  appWeightMb: z.number().int().min(0),
  agentWeightMb: z.number().int().min(0),
  browserWeightMb: z.number().int().min(0),
  agentFloor: z.number().int().min(0),
  // Whether the agent pool is sized from the host's MEASURED free memory rather than from the
  // planned budget minus the runtime weights, which is a difference of two peak-calibrated
  // estimates and is wrong in both directions at once. Off = the planned-only sizing.
  agentPoolMeasuredEnabled: z.boolean(),
  // MB held back from that measurement. 0 = auto (a fifth of the host, clamped to 2048..4096).
  agentPoolSafetyMb: z.number().int().min(0),
  // Whether a task holding no live runtime runner yields its CLI slot to one that does.
  agentReserveEnabled: z.boolean(),
  // Cap on that yield. 0 = strict (no escape); anything else releases a held invocation after
  // this many minutes so a busy runtime fleet slows runner-less work rather than stopping it.
  agentReserveMaxHoldMinutes: z.number().int().min(0),
  // Whether an up-voted task may kill a lower-voted task's RUNNING agent to take its slot. The
  // only lever that reorders work already in flight — vote scoring alone just orders the queue.
  agentPreemptionEnabled: z.boolean(),
  // How long a run is safe from that. Guards against killing a just-restarted victim before it
  // achieves anything; 0 preempts as soon as a higher-voted task queues work.
  agentPreemptionMinRunMinutes: z.number().int().min(0),
  // Whether a higher-voted task waiting for an ENVIRONMENT may reclaim a lower-voted task's live
  // (but settled) runner. Without it, holding a runner is a prerequisite for a vote to count.
  runtimePreemptionEnabled: z.boolean(),
  // How long that waiter parks before the reclaimer forces a settled window by evicting the
  // holder's agent. 0 = never force it.
  runtimePreemptionMaxWaitMinutes: z.number().int().min(0),
});

/** Capacity the current settings actually produce, so the admin card can state it instead of
 *  making the operator divide budget by weight in their head. Derived from the API host's own
 *  RAM/CPU — the api and worker containers run on the same machine with no memory limits, so
 *  they read the same figures the gate will. */
function deriveCapacityPreview(overrides: {
  memoryMb: number;
  cpus: number;
  maxConcurrent: number;
  ddevWeightMb: number;
  appWeightMb: number;
  agentWeightMb: number;
  browserWeightMb: number;
  agentFloor: number;
  agentPoolMeasuredEnabled?: boolean;
  agentPoolSafetyMb?: number;
}): {
  budgetMb: number;
  ddevWeightMb: number;
  appWeightMb: number;
  agentWeightMb: number;
  browserWeightMb: number;
  concurrentDdev: number;
  concurrentDdevWithBrowser: number;
  concurrentApp: number;
  agentsIdle: number;
  /** Agent safety reserve in effect (auto-derived when the override is 0). */
  agentSafetyMb: number;
  /** What the MEASURED path targets on this host right now, ignoring the per-evaluation ramp;
   *  null when it is switched off or the host's free memory cannot be read. Stated separately
   *  from `agentsIdle` because the two answer different questions: what the plan allows on an
   *  idle machine, and what the machine itself says it can hold at this moment. */
  agentsMeasured: number | null;
} {
  const host = readHostResources();
  const caps = deriveRuntimeCaps({
    totalMemMb: host.totalMemMb,
    cpuCount: host.cpuCount,
    overrides,
  });
  const fits = (weightMb: number): number => Math.floor(caps.runtimeBudgetMb / weightMb);
  const agentSafetyMb = deriveAgentSafetyMb(host.totalMemMb, overrides.agentPoolSafetyMb);
  const availableMb = overrides.agentPoolMeasuredEnabled === false ? null : readHostAvailableMb();
  return {
    budgetMb: caps.runtimeBudgetMb,
    ddevWeightMb: caps.ddevWeightMb,
    appWeightMb: caps.appWeightMb,
    agentWeightMb: caps.agentWeightMb,
    browserWeightMb: caps.browserWeightMb,
    concurrentDdev: fits(caps.ddevWeightMb),
    concurrentDdevWithBrowser: fits(caps.ddevWeightMb + caps.browserWeightMb),
    concurrentApp: fits(caps.appWeightMb),
    agentSafetyMb,
    agentsMeasured:
      availableMb === null
        ? null
        : deriveAgentConcurrency({
            caps,
            liveRuntimeWeightMb: 0,
            cpuCount: host.cpuCount,
            // rampStep at the core ceiling so the preview states the TARGET rather than one
            // step toward it — the ramp is a property of successive evaluations, not of the
            // capacity this host has.
            measured: {
              availableMb,
              pendingRuntimeMb: 0,
              liveAgents: 0,
              safetyMb: agentSafetyMb,
              rampStep: host.cpuCount,
            },
          }),
    agentsIdle: deriveAgentConcurrency({
      caps,
      liveRuntimeWeightMb: 0,
      cpuCount: host.cpuCount,
    }),
  };
}

// Machine-aware runtime resource governor: master kill-switch, per-runner memory/CPU caps
// (ceilings), the planning weights the byte budget is spent in, an optional hard count cap,
// the leaked-runner reap grace, and the runtime-holder agent reserve (whether a task holding no
// live runner yields its CLI slot to one that does, and for how long). Any number at 0
// auto-derives from host size. Caps are read at each runner START (~30s config cache); weights,
// master switch and reserve are also published so the worker's admission gate, agent-pool sizing
// and pickup gate retune live.
adminRoutes.get('/config/runtime-limits', async (c) => {
  const [
    enabled,
    memoryMb,
    cpus,
    maxConcurrent,
    idleReapMinutes,
    ddevWeightMb,
    appWeightMb,
    agentWeightMb,
    browserWeightMb,
    agentFloor,
    agentPoolMeasuredEnabled,
    agentPoolSafetyMb,
    agentReserveEnabled,
    agentReserveMaxHoldMinutes,
    agentPreemptionEnabled,
    agentPreemptionMinRunMinutes,
    runtimePreemptionEnabled,
    runtimePreemptionMaxWaitMinutes,
  ] = await Promise.all([
    configService.getBoolean(CONFIG_KEYS.RESOURCE_LIMITS_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.RUNTIME_MEMORY_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_CPUS, 0),
    configService.getNumber(CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES, 180),
    configService.getNumber(CONFIG_KEYS.RUNTIME_DDEV_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_APP_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.AGENT_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_BROWSER_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.AGENT_FLOOR, 0),
    configService.getBoolean(CONFIG_KEYS.AGENT_POOL_MEASURED_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.AGENT_POOL_SAFETY_MB, 0),
    configService.getBoolean(CONFIG_KEYS.AGENT_RESERVE_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.AGENT_RESERVE_MAX_HOLD_MINUTES, 3),
    configService.getBoolean(CONFIG_KEYS.AGENT_PREEMPTION_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.AGENT_PREEMPTION_MIN_RUN_MINUTES, 5),
    configService.getBoolean(CONFIG_KEYS.RUNTIME_PREEMPTION_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.RUNTIME_PREEMPTION_MAX_WAIT_MINUTES, 10),
  ]);
  const settings = {
    enabled,
    memoryMb,
    cpus,
    maxConcurrent,
    idleReapMinutes,
    ddevWeightMb,
    appWeightMb,
    agentWeightMb,
    browserWeightMb,
    agentFloor,
    agentPoolMeasuredEnabled,
    agentPoolSafetyMb,
    agentReserveEnabled,
    agentReserveMaxHoldMinutes,
    agentPreemptionEnabled,
    agentPreemptionMinRunMinutes,
    runtimePreemptionEnabled,
    runtimePreemptionMaxWaitMinutes,
  };
  return c.json({ ...settings, capacity: deriveCapacityPreview(settings) });
});

adminRoutes.put('/config/runtime-limits', async (c) => {
  const body = runtimeLimitsSchema.parse(await c.req.json());
  await Promise.all([
    configService.set(CONFIG_KEYS.RESOURCE_LIMITS_ENABLED, body.enabled ? 'true' : 'false'),
    configService.set(CONFIG_KEYS.RUNTIME_MEMORY_MB, String(body.memoryMb)),
    configService.set(CONFIG_KEYS.RUNTIME_CPUS, String(body.cpus)),
    configService.set(CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES, String(body.maxConcurrent)),
    configService.set(CONFIG_KEYS.RUNTIME_IDLE_REAP_MINUTES, String(body.idleReapMinutes)),
    configService.set(CONFIG_KEYS.RUNTIME_DDEV_WEIGHT_MB, String(body.ddevWeightMb)),
    configService.set(CONFIG_KEYS.RUNTIME_APP_WEIGHT_MB, String(body.appWeightMb)),
    configService.set(CONFIG_KEYS.AGENT_WEIGHT_MB, String(body.agentWeightMb)),
    configService.set(CONFIG_KEYS.RUNTIME_BROWSER_WEIGHT_MB, String(body.browserWeightMb)),
    configService.set(CONFIG_KEYS.AGENT_FLOOR, String(body.agentFloor)),
    configService.set(
      CONFIG_KEYS.AGENT_POOL_MEASURED_ENABLED,
      body.agentPoolMeasuredEnabled ? 'true' : 'false',
    ),
    configService.set(CONFIG_KEYS.AGENT_POOL_SAFETY_MB, String(body.agentPoolSafetyMb)),
    configService.set(
      CONFIG_KEYS.AGENT_RESERVE_ENABLED,
      body.agentReserveEnabled ? 'true' : 'false',
    ),
    configService.set(
      CONFIG_KEYS.AGENT_RESERVE_MAX_HOLD_MINUTES,
      String(body.agentReserveMaxHoldMinutes),
    ),
    configService.set(
      CONFIG_KEYS.AGENT_PREEMPTION_ENABLED,
      body.agentPreemptionEnabled ? 'true' : 'false',
    ),
    configService.set(
      CONFIG_KEYS.AGENT_PREEMPTION_MIN_RUN_MINUTES,
      String(body.agentPreemptionMinRunMinutes),
    ),
    configService.set(
      CONFIG_KEYS.RUNTIME_PREEMPTION_ENABLED,
      body.runtimePreemptionEnabled ? 'true' : 'false',
    ),
    configService.set(
      CONFIG_KEYS.RUNTIME_PREEMPTION_MAX_WAIT_MINUTES,
      String(body.runtimePreemptionMaxWaitMinutes),
    ),
  ]);
  // Retune the admission gate AND the agent pool live (both subscribe to this channel); the
  // per-container caps re-read at the next runner start within the config cache.
  await configService.getRedis().publish(CONFIG_RUNTIME_LIMITS_CHANNEL, String(body.maxConcurrent));
  log.info({ ...body }, 'runtime resource limits updated');
  return c.json({ ...body, capacity: deriveCapacityPreview(body) });
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

const timeoutLadderSchema = z.object({
  // 5..480: below 5 no CLI finishes anything, and a single pass that needs more than
  // eight hours is wedged rather than slow.
  baseMinutes: z.number().int().min(5).max(480),
  // Free text so fractional rungs are expressible ("1,1.33,2"); rejected below if it
  // parses to nothing usable, rather than silently falling back to the built-in ladder
  // and leaving the admin believing their string took effect.
  ladder: z.string().min(1).max(120),
});

// Escalating hard-timeout ladder for CLI invocations. A run SIGKILLed at its budget is
// re-dispatched one rung higher instead of at the same budget; the base is a FLOOR over
// each step's declared timeout, never a replacement. Read per dispatch (within the ~30s
// config cache), so a change applies to the next invocation, not the running one.
adminRoutes.get('/config/cli-timeout-ladder', async (c) => {
  const baseMinutes = await configService.getNumber(
    CONFIG_KEYS.CLI_TIMEOUT_BASE_MINUTES,
    DEFAULT_CLI_TIMEOUT_BASE_MINUTES,
  );
  const ladder =
    (await configService.get(CONFIG_KEYS.CLI_TIMEOUT_LADDER)) ??
    DEFAULT_CLI_TIMEOUT_LADDER.join(',');
  return c.json({ baseMinutes, ladder, rungs: parseTimeoutLadder(ladder) });
});

adminRoutes.put('/config/cli-timeout-ladder', async (c) => {
  const { baseMinutes, ladder } = timeoutLadderSchema.parse(await c.req.json());
  // parseTimeoutLadder falls back to the built-in ladder for unusable input, so compare
  // against a raw parse to tell "the admin typed the defaults" from "the admin typed
  // junk" — only the latter is an error.
  const usable = ladder
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (usable.length === 0) {
    throw new HttpError(400, 'ladder must be comma-separated positive numbers, e.g. "1,1.33,2"');
  }
  await configService.set(CONFIG_KEYS.CLI_TIMEOUT_BASE_MINUTES, String(baseMinutes));
  await configService.set(CONFIG_KEYS.CLI_TIMEOUT_LADDER, usable.join(','));
  log.info({ baseMinutes, ladder: usable }, 'cli timeout ladder updated');
  return c.json({ baseMinutes, ladder: usable.join(','), rungs: usable });
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

const cliPricingSchema = z.object({
  autoUpdateEnabled: z.boolean(),
  displayCurrency: z.enum(DISPLAY_CURRENCIES),
});

// Global pricing settings: the master switch for the per-model price sync, and the
// currency costs are DISPLAYED in. Storage stays USD (what every vendor bills) — the
// currency only picks the conversion applied at read time, at the ECB rate effective on
// the task's own date, so an old task keeps reporting the same figure. The per-CLI
// auto-update toggles live on the pricing page (/cli-pricing); this switch wins over
// all of them.
adminRoutes.get('/config/cli-pricing', async (c) => {
  const autoUpdateEnabled = await configService.getBoolean(
    CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED,
    true,
  );
  const raw = await configService.get(CONFIG_KEYS.COST_DISPLAY_CURRENCY);
  return c.json({
    autoUpdateEnabled,
    displayCurrency: isDisplayCurrency(raw) ? raw : 'USD',
    currencies: DISPLAY_CURRENCIES,
  });
});

adminRoutes.put('/config/cli-pricing', async (c) => {
  const { autoUpdateEnabled, displayCurrency } = cliPricingSchema.parse(await c.req.json());
  await configService.set(
    CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED,
    autoUpdateEnabled ? 'true' : 'false',
  );
  await configService.set(CONFIG_KEYS.COST_DISPLAY_CURRENCY, displayCurrency);
  log.info({ autoUpdateEnabled, displayCurrency }, 'global cli pricing settings updated');
  return c.json({ autoUpdateEnabled, displayCurrency, currencies: DISPLAY_CURRENCIES });
});

const tersenessSchema = z.object({ level: z.enum(TERSENESS_LEVELS) });

// Global output terseness level (off | lite | full | ultra; default full). Appended as a
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

// 3 = the full lens panel (reachability, impact, defenses); 1 = the original single
// generic refuter. Only those two values are meaningful — the worker treats anything
// below the panel size as the single pass, because a partial panel cannot be unanimous
// about what its missing lens would have caught.
const REFUTE_PANEL_LENSES = 3;
const reviewRefuteSchema = z.object({
  enabled: z.boolean(),
  lenses: z.union([z.literal(1), z.literal(REFUTE_PANEL_LENSES)]).optional(),
});

// Refutation pass over blocking code-review findings (default ON). A blocking finding
// costs one of the capped fix rounds, so a refuter is asked to disprove it first; only
// positive, cited evidence dismisses it. The worker reads this per 08c apply (~30s config
// cache), so a flip applies to the next review, not a running one.
adminRoutes.get('/config/review-refute', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.REVIEW_REFUTE_ENABLED, true);
  const lenses = await configService.getNumber(
    CONFIG_KEYS.REVIEW_REFUTE_LENSES,
    REFUTE_PANEL_LENSES,
  );
  return c.json({ enabled, lenses: lenses >= REFUTE_PANEL_LENSES ? REFUTE_PANEL_LENSES : 1 });
});

adminRoutes.put('/config/review-refute', async (c) => {
  const { enabled, lenses } = reviewRefuteSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.REVIEW_REFUTE_ENABLED, enabled ? 'true' : 'false');
  if (lenses !== undefined) {
    await configService.set(CONFIG_KEYS.REVIEW_REFUTE_LENSES, String(lenses));
  }
  log.info({ enabled, lenses }, 'global review-refute switch updated');
  return c.json({
    enabled,
    lenses:
      lenses ??
      (await configService.getNumber(CONFIG_KEYS.REVIEW_REFUTE_LENSES, REFUTE_PANEL_LENSES)),
  });
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

// 1..999 is rejected rather than clamped: the CLI silently ignores a per-server timeout
// below 1000ms and falls back to its own ~28h default, so accepting one would store a
// setting that does nothing. 0 is the explicit "no cap" escape hatch.
const chromeMcpTimeoutSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .refine((v) => v === 0 || v >= 1000, {
      message: 'timeoutMs must be 0 (no cap) or at least 1000',
    }),
});

// Hard per-call cap on chrome-devtools MCP tools, emitted as that server's `timeout` in the
// generated MCP config. Bounds a hung browser tool (observed: a 26-minute close_page) that
// nothing else bounds — progress notifications do not extend it. The worker reads this at
// cli-exec build time (within the ~30s config cache), so a retune needs no redeploy.
adminRoutes.get('/config/chrome-mcp-timeout', async (c) => {
  const timeoutMs = await configService.getNumber(
    CONFIG_KEYS.CHROME_MCP_TOOL_TIMEOUT_MS,
    DEFAULT_CHROME_MCP_TOOL_TIMEOUT_MS,
  );
  return c.json({ timeoutMs });
});

adminRoutes.put('/config/chrome-mcp-timeout', async (c) => {
  const { timeoutMs } = chromeMcpTimeoutSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.CHROME_MCP_TOOL_TIMEOUT_MS, String(timeoutMs));
  log.info({ timeoutMs }, 'chrome-devtools MCP tool timeout updated');
  return c.json({ timeoutMs });
});

const globalPauseSchema = z.object({ paused: z.boolean() });

// Global pause switch. ON stops the orchestrator handing out work everywhere: no step
// advances and no queued CLI invocation is picked up. A CLI already RUNNING finishes —
// nothing is killed, nothing is superseded, no environment is torn down. Terminals, the
// browser IDE, VNC and the DDEV/app runners keep working so a frozen system stays
// debuggable. The worker reads it per advance and per cli-exec pickup (~30s config cache),
// so both directions take effect without a redeploy. Persists across restarts.
adminRoutes.get('/config/global-pause', async (c) => {
  const paused = await configService.getBoolean(CONFIG_KEYS.GLOBAL_PAUSE, false);
  return c.json({ paused });
});

adminRoutes.put('/config/global-pause', async (c) => {
  const { paused } = globalPauseSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.GLOBAL_PAUSE, paused ? 'true' : 'false');
  log.info({ paused }, 'global pause switch updated');
  return c.json({ paused });
});

const modelIdentityStrictSchema = z.object({ enabled: z.boolean() });

// Strict model identity. The 00-model-health canary always RECORDS which model actually
// answered (requested vs served, read from the CLI's own output); this decides whether a
// proven mismatch stops the task or merely warns.
//
// Default OFF, and that default is load-bearing: a mismatch is not inherently an error.
// claude-code legitimately resolves an alias to a dated snapshot, so failing on any
// difference would break ordinary runs. Turn it ON when a provider must be pinned exactly
// and a silent upstream swap — measured 2026-08-18, a provider configured for glm-5.2[1m]
// was served glm-5.3 — should stop the task rather than quietly change the model doing the
// work. Never fires when the CLI reports no model at all (codex, amp): absent evidence is
// 'unknown', not a mismatch.
adminRoutes.get('/config/model-identity-strict', async (c) => {
  const enabled = await configService.getBoolean(CONFIG_KEYS.MODEL_IDENTITY_STRICT, false);
  return c.json({ enabled });
});

adminRoutes.put('/config/model-identity-strict', async (c) => {
  const { enabled } = modelIdentityStrictSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.MODEL_IDENTITY_STRICT, enabled ? 'true' : 'false');
  log.info({ enabled }, 'strict model identity switch updated');
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

const cliStreamLogRetentionSchema = z.object({
  // 0 disables the sweep (transcripts kept forever). Upper bound mirrors the global-KB
  // retention setting; the sweep reads this within the ~30s config cache.
  retentionDays: z.number().int().min(0).max(3650),
});

adminRoutes.get('/config/cli-stream-log-retention', async (c) => {
  const retentionDays = await configService.getNumber(
    CONFIG_KEYS.CLI_STREAM_LOG_RETENTION_DAYS,
    DEFAULT_CLI_STREAM_LOG_RETENTION_DAYS,
  );
  return c.json({ retentionDays });
});

adminRoutes.put('/config/cli-stream-log-retention', async (c) => {
  const { retentionDays } = cliStreamLogRetentionSchema.parse(await c.req.json());
  await configService.set(CONFIG_KEYS.CLI_STREAM_LOG_RETENTION_DAYS, String(retentionDays));
  log.info({ retentionDays }, 'cli stream-log retention updated');
  return c.json({ retentionDays });
});
