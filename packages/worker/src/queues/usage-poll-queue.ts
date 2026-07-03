import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import {
  CONFIG_KEYS,
  QUEUE_NAMES,
  configService,
  logger,
  type CliProviderName,
} from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  claudeTokenNeedsRefresh,
  refreshClaudeToken,
  type ClaudeOauthTokens,
} from '@haive/shared/claude-oauth';
import { USAGE_PROVIDERS, type ProviderUsageConfig } from '../usage-window/fetchers/index.js';
import { constrainingResetAt, allowanceVerdict } from '../usage-window/allowance-watch.js';
import {
  readAuthVolumeFile,
  readProviderSecretToken,
  writeProviderSecret,
} from '../usage-window/token-source.js';
import type { UsageFetchContext, UsageFetchOutcome } from '../usage-window/types.js';

const log = logger.child({ module: 'usage-poll' });

// Gentle by design: a 5-hour/weekly window barely moves minute-to-minute, and the
// claude endpoint 429s aggressive callers. ~5 min base + jitter, with per-provider
// exponential backoff on any 429.
const POLL_BASE_INTERVAL_MS = 5 * 60 * 1000;
const POLL_JOB_ID = 'usage-poll-tick-repeatable';
const POLL_JOB_NAME = 'usage-poll-tick';
const FETCH_CONCURRENCY = 4;
const BACKOFF_BASE_MS = 10 * 60 * 1000; // first 429 -> skip ~2 ticks
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** Per-provider 429 backoff, kept in-process (the poll worker is a singleton). */
const backoff = new Map<string, { until: number; strikes: number }>();

// Extra cushion over a vendor's documented minimum so clock drift / vendor-side
// rounding can't push a call under the limit and trigger a permanent 429.
const POLL_LEEWAY_MS = 10 * 1000;
// Minimum time between actual vendor calls per provider. The repeatable 5-min tick
// always clears this; the extra step-finish-triggered ticks (enqueueUsagePollTick) are
// throttled to it so a burst of finishing steps can't hammer a rate-limited endpoint.
// Claude 429s permanently below ~180s; others are undocumented -> a gentle default.
const MIN_POLL_INTERVAL_MS: Partial<Record<CliProviderName, number>> = {
  'claude-code': 180 * 1000 + POLL_LEEWAY_MS,
};
const DEFAULT_MIN_POLL_INTERVAL_MS = 60 * 1000 + POLL_LEEWAY_MS;

/** Per-provider time of the last actual vendor call (in-process; the poll worker is a
 *  singleton). Drives the min-interval throttle; cleared on restart, where a fresh boot
 *  poll is fine. */
const lastPollAt = new Map<string, number>();

let queueSingleton: Queue | null = null;
function getUsagePollQueue(): Queue {
  if (!queueSingleton) {
    queueSingleton = new Queue(QUEUE_NAMES.USAGE_POLL, { connection: getBullRedis() });
  }
  return queueSingleton;
}

/** Idempotent: upsertJobScheduler keys on POLL_JOB_ID, so a restart UPDATES the one
 *  scheduler rather than adding a duplicate. A fixed interval (no jitter) keeps it
 *  stable; the pre-sweep clears any orphaned legacy repeatable from an earlier boot
 *  (a jittered `every` used to register a fresh repeatable each restart). */
export async function scheduleUsagePollTick(): Promise<void> {
  const queue = getUsagePollQueue();
  for (const r of await queue.getRepeatableJobs().catch(() => [])) {
    await queue.removeRepeatableByKey(r.key).catch(() => {});
  }
  await queue.upsertJobScheduler(
    POLL_JOB_ID,
    { every: POLL_BASE_INTERVAL_MS },
    { name: POLL_JOB_NAME, opts: { removeOnComplete: true, removeOnFail: 10 } },
  );
}

/** Enqueue a one-off poll tick (e.g. right after an LLM step finishes) so the header
 *  usage meters + the per-step stamp refresh promptly instead of only on the 5-min
 *  repeatable. The per-provider min-interval throttle in pollProvider keeps it gentle —
 *  a vendor is never called more often than its rate limit allows. */
export async function enqueueUsagePollTick(opts?: { delayMs?: number }): Promise<void> {
  const delay = opts?.delayMs && opts.delayMs > 0 ? { delay: Math.floor(opts.delayMs) } : {};
  await getUsagePollQueue().add(
    POLL_JOB_NAME,
    {},
    { removeOnComplete: true, removeOnFail: 10, ...delay },
  );
}

interface ProviderRow {
  id: string;
  userId: string;
  name: CliProviderName;
  cliVersion: string | null;
  isolateAuth: boolean;
  envVars: Record<string, string> | null;
}

/** Read a stored ClaudeOauthTokens secret, refreshing (and re-storing the rotated
 *  token) when the access token is near expiry. Returns null when not connected.
 *  Only the singleton poll worker calls this, so the single-use refresh token is never
 *  consumed by two refreshes at once. */
async function resolveOauthRefreshToken(
  db: Database,
  provider: ProviderRow,
  secretName: string,
): Promise<{ token: string } | null> {
  const raw = await readProviderSecretToken(db, provider.id, secretName);
  if (!raw) return null; // usage tracking not connected for this provider
  let stored: ClaudeOauthTokens;
  try {
    stored = JSON.parse(raw) as ClaudeOauthTokens;
  } catch {
    return null;
  }
  if (!stored.accessToken) return null;
  if (stored.refreshToken && claudeTokenNeedsRefresh(stored.expiresAt)) {
    try {
      const fresh = await refreshClaudeToken(stored.refreshToken);
      await writeProviderSecret(db, provider.id, secretName, JSON.stringify(fresh));
      return { token: fresh.accessToken };
    } catch (err) {
      // Refresh failed (revoked / rotated elsewhere / host change). Try the stale token
      // anyway; the fetch will 401 -> error row, surfacing "reconnect" rather than hiding.
      log.warn(
        { providerId: provider.id, err },
        'claude usage token refresh failed; using stale token',
      );
      return { token: stored.accessToken };
    }
  }
  return { token: stored.accessToken };
}

async function resolveToken(
  db: Database,
  provider: ProviderRow,
  cfg: ProviderUsageConfig,
): Promise<{ token: string; accountId?: string | null } | null> {
  if (cfg.token.kind === 'secret') {
    const token = await readProviderSecretToken(db, provider.id, cfg.token.secretName);
    return token ? { token } : null;
  }
  if (cfg.token.kind === 'oauthRefresh') {
    return resolveOauthRefreshToken(db, provider, cfg.token.secretName);
  }
  const raw = await readAuthVolumeFile(
    {
      userId: provider.userId,
      providerId: provider.id,
      providerName: provider.name,
      isolateAuth: provider.isolateAuth,
    },
    cfg.token.authPathIdx,
    cfg.token.relPath,
  );
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const { token, accountId } = cfg.token.extract(json);
  return token ? { token, accountId } : null;
}

async function upsertSnapshot(
  db: Database,
  provider: ProviderRow,
  outcome: Extract<UsageFetchOutcome, { ok: true }> | { ok: false; error: string },
): Promise<void> {
  const now = new Date();
  const iso = (s: string | null | undefined): Date | null => (s ? new Date(s) : null);
  if (outcome.ok) {
    const w = outcome.windows;
    const values = {
      providerId: provider.id,
      userId: provider.userId,
      providerName: provider.name,
      fiveHourPct: w.fiveHour?.usedPct ?? null,
      fiveHourResetAt: iso(w.fiveHour?.resetsAt),
      sevenDayPct: w.sevenDay?.usedPct ?? null,
      sevenDayResetAt: iso(w.sevenDay?.resetsAt),
      dailyPct: w.daily?.usedPct ?? null,
      dailyResetAt: iso(w.daily?.resetsAt),
      status: 'ok',
      errorMessage: null,
      fetchedAt: now,
      updatedAt: now,
    };
    await db
      .insert(schema.usageWindowSnapshots)
      .values(values)
      .onConflictDoUpdate({ target: schema.usageWindowSnapshots.providerId, set: values });
    return;
  }
  // Non-429 error: record status + message, but PRESERVE any prior window values
  // (a transient failure shouldn't drop a good reading; the API treats
  // status='error' as hidden until the next ok tick).
  const msg = outcome.error.slice(0, 240);
  await db
    .insert(schema.usageWindowSnapshots)
    .values({
      providerId: provider.id,
      userId: provider.userId,
      providerName: provider.name,
      status: 'error',
      errorMessage: msg,
      fetchedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.usageWindowSnapshots.providerId,
      set: { status: 'error', errorMessage: msg, fetchedAt: now, updatedAt: now },
    });
}

async function pollProvider(db: Database, provider: ProviderRow): Promise<void> {
  const cfg = USAGE_PROVIDERS[provider.name];
  if (!cfg) return; // provider has no readable window

  const bo = backoff.get(provider.id);
  if (bo && Date.now() < bo.until) return; // still backing off after a 429

  // Min-interval throttle: never call a vendor more often than its rate limit allows.
  // The 5-min repeatable tick always clears this; step-finish-triggered ticks may not.
  const minInterval = MIN_POLL_INTERVAL_MS[provider.name] ?? DEFAULT_MIN_POLL_INTERVAL_MS;
  if (Date.now() - (lastPollAt.get(provider.id) ?? 0) < minInterval) return;

  const creds = await resolveToken(db, provider, cfg);
  if (!creds) return; // not logged in / no token -> skip silently (no error row)
  lastPollAt.set(provider.id, Date.now()); // record the actual vendor-call time

  const ctx: UsageFetchContext = {
    providerName: provider.name,
    cliVersion: provider.cliVersion,
    baseUrl: provider.envVars?.ANTHROPIC_BASE_URL ?? null,
    accountId: creds.accountId ?? null,
  };
  const outcome = await cfg.fetch(creds.token, ctx);

  if (!outcome.ok && outcome.rateLimited) {
    const strikes = (bo?.strikes ?? 0) + 1;
    const until = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (strikes - 1));
    backoff.set(provider.id, { until, strikes });
    log.warn(
      { providerId: provider.id, provider: provider.name, strikes },
      'usage endpoint 429; backing off',
    );
    return;
  }
  backoff.delete(provider.id); // any non-429 response clears the 429 backoff
  await upsertSnapshot(db, provider, outcome);
}

async function runUsagePollTick(db: Database): Promise<void> {
  if (!(await configService.getBoolean(CONFIG_KEYS.USAGE_WINDOW_ENABLED, true))) return;

  const supported = new Set(Object.keys(USAGE_PROVIDERS));
  const providers = (await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.enabled, true),
    columns: {
      id: true,
      userId: true,
      name: true,
      cliVersion: true,
      isolateAuth: true,
      envVars: true,
    },
  })) as ProviderRow[];
  const targets = providers.filter((p) => supported.has(p.name));

  if (targets.length > 0) {
    for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
      const batch = targets.slice(i, i + FETCH_CONCURRENCY);
      await Promise.allSettled(batch.map((p) => pollProvider(db, p)));
    }
    log.debug({ count: targets.length }, 'usage poll tick complete');
  }

  // Allowance-back watch: after refreshing snapshots, notify any task that failed on a
  // provider rate-limit whose allowance has since replenished. Runs even when no provider
  // is currently pollable, so a task can still resolve off an existing snapshot / passed reset.
  await checkAllowanceReplenishment(db);
}

/** Notify-only detect half of the allowance-back watch. For every task the arm path parked
 *  (status='failed', awaiting_allowance_provider_id set, not yet replenished), decide whether
 *  the depleted provider's allowance is back and, if so, stamp allowance_replenished_at (the
 *  signal the web notifier diffs) + clear the watch + append a task_events row. "Back" =
 *  the captured vendor reset has passed (authoritative) OR the snapshot's max consumed %
 *  fell below RECOVERED_PCT (covers providers with no readable reset, e.g. zai, and early
 *  recovery). Reads only stored snapshots, so it ignores the per-provider 429 backoff. */
async function checkAllowanceReplenishment(db: Database): Promise<void> {
  const armed = await db
    .select({
      id: schema.tasks.id,
      providerId: schema.tasks.awaitingAllowanceProviderId,
      resetAt: schema.tasks.allowanceResetAt,
    })
    .from(schema.tasks)
    .where(
      and(
        isNotNull(schema.tasks.awaitingAllowanceProviderId),
        isNull(schema.tasks.allowanceReplenishedAt),
        eq(schema.tasks.status, 'failed'),
      ),
    );
  if (armed.length === 0) return;

  // One snapshot read per distinct provider (several tasks can await the same one).
  const providerIds = [...new Set(armed.map((a) => a.providerId).filter((p): p is string => !!p))];
  const snaps = await db
    .select({
      providerId: schema.usageWindowSnapshots.providerId,
      status: schema.usageWindowSnapshots.status,
      fiveHourPct: schema.usageWindowSnapshots.fiveHourPct,
      fiveHourResetAt: schema.usageWindowSnapshots.fiveHourResetAt,
      sevenDayPct: schema.usageWindowSnapshots.sevenDayPct,
      sevenDayResetAt: schema.usageWindowSnapshots.sevenDayResetAt,
      dailyPct: schema.usageWindowSnapshots.dailyPct,
      dailyResetAt: schema.usageWindowSnapshots.dailyResetAt,
    })
    .from(schema.usageWindowSnapshots)
    .where(inArray(schema.usageWindowSnapshots.providerId, providerIds));
  const snapById = new Map(snaps.map((s) => [s.providerId, s]));

  const now = Date.now();
  for (const task of armed) {
    if (!task.providerId) continue;
    const snap = snapById.get(task.providerId);
    // Backfill the reset if the arm path couldn't capture it (no snapshot yet) but the
    // window is now visible — so a later tick can fire on the authoritative reset.
    let resetAt = task.resetAt;
    if (!resetAt && snap) resetAt = constrainingResetAt(snap) ?? null;

    const verdict = allowanceVerdict({
      resetAt,
      windows: snap ?? null,
      snapshotOk: snap?.status === 'ok',
      now,
    });

    if (!verdict.back) {
      // Not back yet. Persist a freshly-backfilled reset so the next tick can fire on it.
      if (resetAt && resetAt !== task.resetAt) {
        await db
          .update(schema.tasks)
          .set({ allowanceResetAt: resetAt, updatedAt: new Date() })
          .where(eq(schema.tasks.id, task.id));
      }
      continue;
    }

    await db
      .update(schema.tasks)
      .set({
        allowanceReplenishedAt: new Date(),
        awaitingAllowanceProviderId: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, task.id));
    await db.insert(schema.taskEvents).values({
      taskId: task.id,
      taskStepId: null,
      eventType: 'task.allowance_replenished',
      payload: { providerId: task.providerId, via: verdict.via },
    });
    log.info({ taskId: task.id, providerId: task.providerId }, 'allowance replenished; notifying');
  }
}

export function startUsagePollWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.USAGE_POLL,
    async (_job: Job) => {
      await runUsagePollTick(getDb());
    },
    { connection: getBullRedis(), concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, err }, 'usage poll tick failed');
  });
  return worker;
}
