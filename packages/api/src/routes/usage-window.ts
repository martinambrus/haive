import { Hono } from 'hono';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type AuthMode, type UsageWindowSnapshot } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
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

// How long after a credential repair we are still willing to call a dead-token snapshot
// "pending" rather than "reconnect". Three poll cycles: past that the poller has had every
// chance to overwrite the row, so a still-unchanged snapshot means the repair did not take
// and the user deserves the prompt back rather than a spinner that never resolves.
const REPAIR_PENDING_MS = 15 * 60 * 1000;

function toSnapshot(
  row: SnapshotRow,
  now: number,
  repairedAt: Record<string, Date>,
): UsageWindowSnapshot {
  const base =
    row.status === 'error' ? 'error' : row.status === 'needs_reconnect' ? 'needs_reconnect' : 'ok';
  // A reconnect the poller has not caught up with yet. The snapshot still SAYS the token is
  // dead because only a poll tick can change that, and the tick is up to ~5 min out — so
  // without this the user fixes the credential, reloads, is told to reconnect again, and
  // reasonably concludes the fix did not work. Bounded by both ends: the repair must be newer
  // than the reading it contradicts, and recent enough to still be plausibly in flight.
  const repaired = repairedAt[row.providerId];
  const pending =
    base === 'needs_reconnect' &&
    repaired !== undefined &&
    repaired.getTime() > row.fetchedAt.getTime() &&
    now - repaired.getTime() < REPAIR_PENDING_MS;

  return {
    providerId: row.providerId,
    providerName: row.providerName,
    fiveHour: toWindow(row.fiveHourPct, row.fiveHourResetAt),
    sevenDay: toWindow(row.sevenDayPct, row.sevenDayResetAt),
    daily: toWindow(row.dailyPct, row.dailyResetAt),
    fetchedAt: row.fetchedAt.toISOString(),
    stale: now - row.fetchedAt.getTime() > STALE_AFTER_MS,
    status: pending ? 'pending' : base,
  };
}

/** When each provider's usage credential was last replaced, per the repair path that owns it:
 *
 *  - Interactive CLI login (codex/amp/antigravity) ends in a probe that stamps
 *    `auth_last_checked_at` and `auth_status`. Only a PASSING probe counts — a login the user
 *    abandoned leaves the dead credential exactly where it was, and calling that a repair
 *    would swallow the prompt they still need.
 *  - The claude usage-OAuth reconnect writes a new usage secret, so that row's `updated_at`
 *    is the repair instant. Its own CLI login is irrelevant here: the meters run on this
 *    separate credential.
 *
 *  This is what separates "the token is dead" from "the user just fixed it and the poller has
 *  not run yet" — one snapshot row, two very different things to tell the user. */
async function credentialRepairedAt(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<Record<string, Date>> {
  const [probes, secrets] = await Promise.all([
    db
      .select({
        id: schema.cliProviders.id,
        authStatus: schema.cliProviders.authStatus,
        authLastCheckedAt: schema.cliProviders.authLastCheckedAt,
      })
      .from(schema.cliProviders)
      .where(eq(schema.cliProviders.userId, userId)),
    db
      .select({
        providerId: schema.cliProviderSecrets.providerId,
        updatedAt: schema.cliProviderSecrets.updatedAt,
      })
      .from(schema.cliProviderSecrets)
      .innerJoin(
        schema.cliProviders,
        eq(schema.cliProviderSecrets.providerId, schema.cliProviders.id),
      )
      .where(
        and(
          eq(schema.cliProviders.userId, userId),
          eq(schema.cliProviderSecrets.secretName, CLAUDE_USAGE_OAUTH_SECRET),
        ),
      ),
  ]);

  const out: Record<string, Date> = {};
  const keepLatest = (id: string, at: Date | null) => {
    if (!at) return;
    const current = out[id];
    if (!current || at.getTime() > current.getTime()) out[id] = at;
  };
  for (const p of probes) if (p.authStatus === 'ok') keepLatest(p.id, p.authLastCheckedAt);
  for (const s of secrets) keepLatest(s.providerId, s.updatedAt);
  return out;
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

/** Stable identity of the ALLOWANCE a snapshot's numbers describe — the credential set the
 *  CLI actually spends, not the provider row that happens to report it.
 *
 *  This mirrors what resolveCliAuthUserVolumeName (@haive/shared) actually resolves, and has
 *  to keep mirroring it — the key is only meaningful because it names the same sharing the
 *  volume does. An isolated row mounts its own per-provider volume and therefore has its own
 *  login and its own quota. Non-isolated rows of the same CLI name share a volume ONLY when
 *  they also share an auth mode: an API-key row and a subscription row are two credentials
 *  billing two accounts, so collapsing them would attribute a subscription's depletion to a
 *  row spending a metered key.
 *
 *  Four `claude-code` rows (Fable Low / Max / xHigh, Sonnet xHigh) in one mode are a single
 *  Claude subscription, which is why they report the same reset instant and the same weekly
 *  percentage; alerting per row fired four identical "usage low" notifications for one
 *  depleting allowance. Per-user by construction — the route is already scoped to the
 *  caller, so a shared key never spans two people. */
function providerAllowanceKey(row: {
  id: string;
  name: string;
  isolateAuth: boolean;
  authMode: AuthMode;
}): string {
  if (row.isolateAuth) return `provider:${row.id}`;
  // Auth mode is part of the key for the same reason it is part of the volume name
  // (resolveCliAuthUserVolumeName): rows of one CLI no longer share a credential across
  // modes, so an API-key row and a subscription row are two allowances, not one. Collapsing
  // them would attribute a subscription's depletion to a row billing a metered key.
  // Mirrors the volume scheme's asymmetry deliberately — subscription keeps the historical
  // key so existing depletion episodes are not re-baselined, and only api_key gains a
  // suffix. Keep the two in lockstep; they describe the same sharing.
  return row.authMode === 'api_key' ? `shared:${row.name}:api_key` : `shared:${row.name}`;
}

/** providerId -> allowance key, for every CLI provider the caller owns. The notifier keys
 *  its depletion episodes on this instead of the provider id, so rows sharing a
 *  subscription collapse into one alert. */
async function allowanceKeys(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      id: schema.cliProviders.id,
      name: schema.cliProviders.name,
      isolateAuth: schema.cliProviders.isolateAuth,
      authMode: schema.cliProviders.authMode,
    })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.id, providerAllowanceKey(r)]));
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
  const [alertEnabled, windowEnabled, thresholdPct, prefs, activeIds, allowance, repairedAt] =
    await Promise.all([
      configService.getBoolean(CONFIG_KEYS.USAGE_ALERT_ENABLED, true),
      configService.getBoolean(CONFIG_KEYS.USAGE_WINDOW_ENABLED, true),
      configService.getNumber(CONFIG_KEYS.USAGE_ALERT_THRESHOLD_PCT, 10),
      db.query.userNotificationSettings.findFirst({
        where: eq(schema.userNotificationSettings.userId, userId),
        columns: { usageAlertEnabled: true },
      }),
      activeProviderIds(db, userId),
      allowanceKeys(db, userId),
      credentialRepairedAt(db, userId),
    ]);
  const now = Date.now();
  return c.json({
    snapshots: rows.map((r) => toSnapshot(r, now, repairedAt)),
    alert: {
      enabled: alertEnabled && windowEnabled && (prefs?.usageAlertEnabled ?? true),
      thresholdPct,
      activeProviderIds: activeIds,
      allowanceKeys: allowance,
    },
  });
});
