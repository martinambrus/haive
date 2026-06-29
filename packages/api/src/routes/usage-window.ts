import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { UsageWindowSnapshot } from '@haive/shared';
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
    status: row.status === 'error' ? 'error' : 'ok',
  };
}

// Latest usage-window snapshot for each of the caller's CLI providers. The header
// chip picks the row matching the active step's provider; rows are written by the
// worker's gentle poller. Returns all rows (incl. status='error'/stale) and lets
// the chip decide what to show.
usageWindowRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await getDb().query.usageWindowSnapshots.findMany({
    where: eq(schema.usageWindowSnapshots.userId, userId),
  });
  const now = Date.now();
  return c.json({ snapshots: rows.map((r) => toSnapshot(r, now)) });
});
