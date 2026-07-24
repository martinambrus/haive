import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
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
  const [alertEnabled, windowEnabled, thresholdPct, prefs] = await Promise.all([
    configService.getBoolean(CONFIG_KEYS.USAGE_ALERT_ENABLED, true),
    configService.getBoolean(CONFIG_KEYS.USAGE_WINDOW_ENABLED, true),
    configService.getNumber(CONFIG_KEYS.USAGE_ALERT_THRESHOLD_PCT, 10),
    db.query.userNotificationSettings.findFirst({
      where: eq(schema.userNotificationSettings.userId, userId),
      columns: { usageAlertEnabled: true },
    }),
  ]);
  const now = Date.now();
  return c.json({
    snapshots: rows.map((r) => toSnapshot(r, now)),
    alert: {
      enabled: alertEnabled && windowEnabled && (prefs?.usageAlertEnabled ?? true),
      thresholdPct,
    },
  });
});
