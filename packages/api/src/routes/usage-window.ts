import { Hono } from 'hono';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type UsageWindowSnapshot } from '@haive/shared';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../context.js';

export const usageWindowRoutes = new Hono<AppEnv>();
usageWindowRoutes.use('*', requireAuth);

// A snapshot older than ~2.5 poll intervals (poll is ~5 min) is "stale": the
// header chip dims it instead of trusting a number the poller stopped refreshing.
const STALE_AFTER_MS = 13 * 60 * 1000;

type SnapshotRow = typeof schema.usageWindowSnapshots.$inferSelect;

function toWindow(pct: number | null, resetAt: Date | null): UsageWindowSnapshot['fiveHour'] {
  return pct == null
    ? undefined
    : { usedPct: pct, resetsAt: resetAt ? resetAt.toISOString() : null };
}

function toSnapshot(row: SnapshotRow, now: number): UsageWindowSnapshot {
  return {
    providerId: row.providerId,
    providerName: row.providerName,
    fiveHour: toWindow(row.fiveHourPct, row.fiveHourResetAt),
    sevenDay: toWindow(row.sevenDayPct, row.sevenDayResetAt),
    daily: toWindow(row.dailyPct, row.dailyResetAt),
    fetchedAt: row.fetchedAt.toISOString(),
    stale: now - row.fetchedAt.getTime() > STALE_AFTER_MS,
    status:
      row.status === 'error'
        ? 'error'
        : row.status === 'needs_reconnect'
          ? 'needs_reconnect'
          : 'ok',
  };
}

/** Provider ids the caller has live work on right now. Two sources, unioned:
 *  - every task in `running` (its default CLI is what its next LLM step will spend), and
 *  - every in-flight CLI invocation on a non-terminal task, which catches a step-level CLI
 *    override the task default hides, and a task parked at a gate while a mining fan-out is
 *    still burning allowance. Terminal tasks are excluded so a leaked never-ended row on a
 *    failed/cancelled task can't keep a provider looking busy forever.
 *
 *  Gates the depletion alert only: "codex is nearly out" is actionable while something is
 *  spending codex, and pure noise when every codex task is already parked on the exhausted
 *  allowance (the state that produced the report — 8 failed codex tasks, zero running). The
 *  numbers themselves are never gated; the header chip keeps showing them. */
async function activeProviderIds(db: ReturnType<typeof getDb>, userId: string): Promise<string[]> {
  const [running, live] = await Promise.all([
    db
      .select({ providerId: schema.tasks.cliProviderId })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.userId, userId), eq(schema.tasks.status, 'running'))),
    db
      .select({ providerId: schema.cliInvocations.cliProviderId })
      .from(schema.cliInvocations)
      .innerJoin(schema.tasks, eq(schema.cliInvocations.taskId, schema.tasks.id))
      .where(
        and(
          eq(schema.tasks.userId, userId),
          isNull(schema.cliInvocations.endedAt),
          isNull(schema.cliInvocations.supersededAt),
          notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
        ),
      ),
  ]);
  return [
    ...new Set(
      [...running, ...live].map((r) => r.providerId).filter((id): id is string => id !== null),
    ),
  ];
}

// Latest usage-window snapshot for each of the caller's CLI providers. The header
// chip picks the row matching the active step's provider; rows are written by the
// worker's gentle poller. Returns all rows (incl. status='error'/stale) and lets
// the chip decide what to show.
//
// `alert` rides along so the notifier (NotificationProvider's usage channel) resolves
// the depletion-alert config in the same fetch it already makes for the numbers. The
// three switches are AND-ed server-side: the admin global, the usage-window global
// (without the poller every snapshot goes stale and alerting off a frozen number is
// worse than staying quiet), and this user's own opt-out.
usageWindowRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const db = getDb();
  const rows = await db.query.usageWindowSnapshots.findMany({
    where: eq(schema.usageWindowSnapshots.userId, userId),
  });
  const [alertEnabled, windowEnabled, thresholdPct, prefs, activeIds] = await Promise.all([
    configService.getBoolean(CONFIG_KEYS.USAGE_ALERT_ENABLED, true),
    configService.getBoolean(CONFIG_KEYS.USAGE_WINDOW_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.USAGE_ALERT_THRESHOLD_PCT, 10),
    db.query.userNotificationSettings.findFirst({
      where: eq(schema.userNotificationSettings.userId, userId),
      columns: { usageAlertEnabled: true },
    }),
    activeProviderIds(db, userId),
  ]);
  const now = Date.now();
  return c.json({
    snapshots: rows.map((r) => toSnapshot(r, now)),
    alert: {
      enabled: alertEnabled && windowEnabled && (prefs?.usageAlertEnabled ?? true),
      thresholdPct,
      activeProviderIds: activeIds,
    },
  });
});
