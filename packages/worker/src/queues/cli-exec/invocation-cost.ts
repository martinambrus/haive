import { and, eq, isNull, or } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_PROVIDER_CATALOG,
  CONFIG_KEYS,
  canonicalModelKey,
  computeInvocationCost,
  configService,
  inputIncludesCache,
  pickLivePrice,
  resolveCostDecision,
  type CacheTtl,
  type CliProviderName,
  type CliTokenUsage,
  type InvocationCost,
  type LivePriceRow,
  type ModelIdentity,
} from '@haive/shared';
import { log } from './_shared.js';

/** Resolve what one finished invocation cost.
 *
 *  Called from the cli-exec completion path beside token_usage and model_identity —
 *  the one place where the provider, its auth mode, the token buckets and the
 *  answering model are all in hand at once. Everything it returns is a SNAPSHOT: the
 *  rates it used are stored on the row, so a later vendor price change cannot restate
 *  what a finished task cost.
 *
 *  Returns null when there is nothing to record (no token usage at all), which is a
 *  different fact from a zero cost and is why the column is nullable. */
export async function resolveInvocationCost(
  db: Database,
  input: {
    cliProviderId: string | null;
    /** As `resolveProviderNameForPayload` returns it: a `string` that is a
     *  cli_provider_name in practice, narrowed here rather than cast, so a name this
     *  build does not know about yields no cost instead of a bad lookup. */
    providerName: string | null;
    tokenUsage: CliTokenUsage | null;
    modelIdentity: ModelIdentity | null;
  },
): Promise<InvocationCost | null> {
  const { tokenUsage, modelIdentity } = input;
  const providerName =
    input.providerName && input.providerName in CLI_PROVIDER_CATALOG
      ? (input.providerName as CliProviderName)
      : null;
  if (!tokenUsage || !providerName) return null;

  const provider = input.cliProviderId
    ? await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, input.cliProviderId),
        columns: { authMode: true, model: true },
      })
    : null;
  // A provider row deleted mid-run leaves the invocation unattributable. Default to
  // subscription, the non-billable reading: inventing real dollars for a run whose
  // billing arrangement is unknown is the one error worth avoiding here.
  const authMode = provider?.authMode ?? 'subscription';

  // Which model to price. `served` is what actually answered and is preferred over
  // `requested`; the provider's configured model is the last resort, and the ONLY
  // channel codex has — it reports no model at all (see the ModelIdentity doc).
  const modelKey = canonicalModelKey(
    modelIdentity?.served ?? modelIdentity?.requested ?? provider?.model ?? null,
  );

  const cacheTtl = await resolveCacheTtl();
  const reportedCostUsd =
    typeof tokenUsage.costUsd === 'number' && Number.isFinite(tokenUsage.costUsd)
      ? tokenUsage.costUsd
      : null;

  const candidates = modelKey ? await loadLivePrices(db, providerName, modelKey) : [];
  const feedGate = await loadFeedGate(db, providerName);
  // `auto_update_enabled = false` means this provider's rates are admin-owned, so its
  // synced feed rows are ignored here even though they are still stored. Enforced at
  // LOOKUP rather than only at sync time so flipping the toggle takes effect on the
  // next invocation instead of at the next 12-hourly refresh.
  const usable = feedGate.autoUpdateEnabled
    ? candidates
    : candidates.filter((row) => row.source === 'manual');
  const chosen = pickLivePrice(usable, feedGate.preferredFeed);

  const decision = resolveCostDecision({
    provider: providerName,
    authMode,
    hasManualRate: chosen?.source === 'manual',
    hasFeedRate: chosen !== null && chosen.source !== 'manual',
    hasReportedCost: reportedCostUsd !== null,
  });

  if (decision.source === 'reported' && reportedCostUsd !== null) {
    return {
      costUsd: reportedCostUsd,
      currency: 'USD',
      source: 'reported',
      billable: decision.billable,
      modelKey,
      priceRowId: null,
      rates: null,
      cacheTtl,
      unpricedBuckets: [],
    };
  }

  if ((decision.source === 'computed' || decision.source === 'manual') && chosen) {
    const computed = computeInvocationCost(tokenUsage, chosen.rates, {
      cacheTtl,
      inputIncludesCache: inputIncludesCache(providerName),
    });
    // A partial total is worse than no total: it looks like a cost and is not one. Such
    // a row is recorded unpriced, keeping the rates and the offending buckets so the
    // admin page can say WHICH rate is missing rather than just "unknown".
    if (computed.unpricedBuckets.length > 0) {
      return {
        costUsd: 0,
        currency: 'USD',
        source: 'none',
        billable: false,
        modelKey,
        priceRowId: chosen.id,
        rates: chosen.rates,
        cacheTtl,
        unpricedBuckets: computed.unpricedBuckets,
      };
    }
    return {
      costUsd: computed.costUsd,
      currency: 'USD',
      source: decision.source,
      billable: decision.billable,
      modelKey,
      priceRowId: chosen.id,
      rates: chosen.rates,
      cacheTtl,
      unpricedBuckets: [],
    };
  }

  return {
    costUsd: 0,
    currency: 'USD',
    source: 'none',
    billable: false,
    modelKey,
    priceRowId: null,
    rates: null,
    cacheTtl,
    unpricedBuckets: [],
  };
}

/** Live rates for this model: the provider's own rows plus any vendor-wide manual row
 *  (`provider IS NULL`). Ordering between them is `pickLivePrice`'s job, not the
 *  query's. */
async function loadLivePrices(
  db: Database,
  providerName: CliProviderName,
  modelKey: string,
): Promise<LivePriceRow[]> {
  const rows = await db
    .select()
    .from(schema.cliModelPrices)
    .where(
      and(
        isNull(schema.cliModelPrices.effectiveTo),
        eq(schema.cliModelPrices.modelKey, modelKey),
        or(
          eq(schema.cliModelPrices.provider, providerName),
          isNull(schema.cliModelPrices.provider),
        ),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider as CliProviderName | null,
    modelKey: row.modelKey,
    source: row.source,
    rates: row.rates,
    effectiveFrom: row.effectiveFrom,
  }));
}

async function loadFeedGate(
  db: Database,
  providerName: CliProviderName,
): Promise<{
  autoUpdateEnabled: boolean;
  preferredFeed: 'openrouter' | 'litellm' | 'manual' | null;
}> {
  const row = await db.query.cliPricingSync.findFirst({
    where: eq(schema.cliPricingSync.name, providerName),
    columns: { autoUpdateEnabled: true, preferredFeed: true },
  });
  // No row = the column default, i.e. enabled. A provider added by a migration later
  // than 0120 must price normally rather than silently going unpriced.
  return {
    autoUpdateEnabled: row?.autoUpdateEnabled ?? true,
    preferredFeed: row?.preferredFeed ?? null,
  };
}

/** Which cache TTL the run used, for the cache-WRITE rate (1h costs 2x base against
 *  5m's 1.25x, so this is not a rounding detail).
 *
 *  Read here rather than snapshotted at dispatch because the flag is a global config
 *  the dispatch path applies moments earlier in the same process (`exec-core.ts`), and
 *  `cli_invocations.env_vars` — the obvious place to have recorded it — is verified
 *  dead (never written, all-null). try/catch because configService is not backed in
 *  the unit environment, and a cost detail must never throw where a step would notice
 *  (same lesson as augmentPromptWithTerseness). */
async function resolveCacheTtl(): Promise<CacheTtl> {
  try {
    return (await configService.getBoolean(CONFIG_KEYS.PROMPT_CACHING_1H, false)) ? '1h' : '5m';
  } catch (err) {
    log.debug({ err }, 'prompt-caching-1h config unavailable; pricing cache writes at 5m');
    return '5m';
  }
}
