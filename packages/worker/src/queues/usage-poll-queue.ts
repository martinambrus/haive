import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
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

  const creds = await resolveToken(db, provider, cfg);
  if (!creds) return; // not logged in / no token -> skip silently (no error row)

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
  if (targets.length === 0) return;

  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const batch = targets.slice(i, i + FETCH_CONCURRENCY);
    await Promise.allSettled(batch.map((p) => pollProvider(db, p)));
  }
  log.debug({ count: targets.length }, 'usage poll tick complete');
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
