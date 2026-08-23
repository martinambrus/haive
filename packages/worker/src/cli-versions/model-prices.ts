import { and, eq, isNull, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_PROVIDER_LIST,
  CONFIG_KEYS,
  configService,
  ECB_DAILY_FX_URL,
  LITELLM_PRICES_URL,
  hasAnyRate,
  litellmRowsForProviders,
  logger,
  parseEcbDailyRates,
  parseLitellmPrices,
  ratesEqual,
  type CliProviderName,
  type ModelPriceRates,
  type RefreshCliVersionsJobResult,
} from '@haive/shared';
import { fetchOllamaModelPrices } from './ollama-model-prices.js';

const log = logger.child({ module: 'model-price-refresh' });

/** Generous but bounded: this shares the REFRESH_VERSIONS job with the CLI, tool and
 *  OpenRouter-catalog refreshers, and a hung feed must not wedge it. Matches the
 *  timeout `refreshOpenRouterModels` uses for the same reason. */
const FETCH_TIMEOUT_MS = 30_000;

/** One row the sync wants to exist, before it is compared with what is stored. */
interface DesiredRow {
  provider: CliProviderName;
  modelKey: string;
  source: 'litellm' | 'openrouter' | 'ollama';
  rates: ModelPriceRates;
}

/** Refresh per-model token rates from the public feeds.
 *
 *  Mirrors `refreshOpenRouterModels` deliberately, including the failure branch that
 *  RECORDS the error on the row instead of throwing: this runs inside the shared
 *  REFRESH_VERSIONS job, and a gateway blip must neither fail that job nor wipe
 *  rates that were good a minute ago. On error the stored rows are left exactly as
 *  they were and only `fetch_error` moves, so pricing keeps working from the last
 *  good sync and the admin page can surface the staleness.
 *
 *  Effective dating: a rate that has not moved is a NO-OP. Only a genuine change
 *  closes the live row (`effective_to = now()`) and inserts its replacement, so the
 *  history holds real price changes rather than one row per 12-hourly tick.
 *
 *  `auto_update_enabled = false` for a provider means "this provider's rates are
 *  admin-owned": no feed row is written for it here, and the cost path ignores feed
 *  rows for it too (the lookup-side gate is the authoritative one, so switching the
 *  toggle takes effect immediately rather than at the next sync).
 *
 *  Runs AFTER `refreshOpenRouterModels` in the job, not beside it, because it reads
 *  that refresher's cache rather than re-fetching the 4 MB catalog.
 *
 *  Three feeds, not two, because the vendors publish in three incompatible shapes: a
 *  price document (LiteLLM), a catalog API (OpenRouter), and — for Ollama — nothing at
 *  all except a figure on each model's own page. */
export async function refreshModelPrices(db: Database): Promise<RefreshCliVersionsJobResult> {
  // Global kill-switch. OFF means no feed is fetched at all and every stored rate stays
  // exactly as it is, which is the posture an install on negotiated rates wants once it
  // has entered its own. Deliberately a clean no-op rather than an error: nothing is
  // wrong, the operator asked for this. Fail-open on a config read failure — pricing is
  // observability, and a Redis blip should not silently freeze it.
  let enabledGlobally = true;
  try {
    enabledGlobally = await configService.getBoolean(CONFIG_KEYS.PRICING_AUTO_UPDATE_ENABLED, true);
  } catch (err) {
    log.debug({ err }, 'pricing auto-update config unavailable; proceeding');
  }
  if (!enabledGlobally) {
    log.info('price sync disabled by PRICING_AUTO_UPDATE_ENABLED; leaving rates untouched');
    return { ok: true, refreshed: [], errors: [] };
  }

  const syncRows = await db.select().from(schema.cliPricingSync);
  const enabled = new Set<CliProviderName>(
    syncRows.filter((r) => r.autoUpdateEnabled).map((r) => r.name as CliProviderName),
  );
  // A provider with no sync row yet (added by a later migration than 0120) is treated
  // as enabled, matching the column default rather than silently going unpriced.
  for (const p of CLI_PROVIDER_LIST) {
    if (!syncRows.some((r) => r.name === p.name)) enabled.add(p.name as CliProviderName);
  }

  const desired: DesiredRow[] = [];
  const errors: RefreshCliVersionsJobResult['errors'] = [];

  // --- LiteLLM: direct-vendor rates for everything except the gateway ---
  const litellmProviders = [...enabled];
  try {
    const resp = await fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`${LITELLM_PRICES_URL} HTTP ${resp.status}`);
    const entries = parseLitellmPrices(await resp.json());
    // An empty parse from a 200 means the document shape moved under us. Treated as an
    // error rather than "no models are priced any more" — the second reading would
    // quietly stop pricing every provider.
    if (entries.length === 0) throw new Error('litellm feed parsed to 0 chat entries');
    for (const row of litellmRowsForProviders(entries, litellmProviders)) {
      desired.push({ ...row, source: 'litellm' });
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ error }, 'failed to refresh litellm model prices');
    for (const provider of litellmProviders) errors.push({ name: `price:${provider}`, error });
    await recordSyncError(db, litellmProviders, error);
  }

  // --- OpenRouter: the gateway's own resale rates, from the cache the sibling
  // refresher just wrote. Never priced from a vendor rate: OpenRouter bills its own
  // margin at the ROUTED model's price, which is wrong by a different factor per
  // model (catalog.ts:436).
  if (enabled.has('openrouter')) {
    try {
      const cache = await db.query.openrouterModelCache.findFirst({
        where: eq(schema.openrouterModelCache.name, 'openrouter'),
      });
      const models = cache?.models ?? [];
      if (models.length === 0) {
        // Not an error: an empty catalog is the documented degraded state (the picker
        // falls back to a free-text model field), so pricing degrades the same way.
        log.info('openrouter catalog empty — no gateway prices to sync');
      }
      for (const m of models) {
        const rates: ModelPriceRates = {
          inputRate: m.promptPrice,
          outputRate: m.completionPrice,
          cacheReadRate: m.cacheReadPrice,
          cacheWriteRate: m.cacheWritePrice,
          cacheWrite1hRate: m.cacheWrite1hPrice,
        };
        if (!hasAnyRate(rates)) continue;
        const modelKey = m.id.trim().toLowerCase();
        if (!modelKey) continue;
        desired.push({ provider: 'openrouter', modelKey, source: 'openrouter', rates });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn({ error }, 'failed to read openrouter catalog for pricing');
      errors.push({ name: 'price:openrouter', error });
      await recordSyncError(db, ['openrouter'], error);
    }
  }

  // --- Ollama: rates scraped from the model pages, the only place Ollama states one.
  // NOT priced from the LiteLLM `ollama` vendor rows: every one of those is 0, which is
  // the truth for a local model and a LIE for the four CLOUD models the feed also
  // carries — and a stored 0 is a PRICE, so it would record a real $0.00 cost.
  if (enabled.has('ollama')) {
    const { rows, errors: pageErrors } = await fetchOllamaModelPrices(db);
    for (const row of rows) {
      desired.push({
        provider: 'ollama',
        modelKey: row.modelKey,
        source: 'ollama',
        rates: row.rates,
      });
    }
    if (pageErrors.length > 0) {
      const error = pageErrors.join('; ');
      errors.push({ name: 'price:ollama', error });
      await recordSyncError(db, ['ollama'], error);
    }
  }

  if (desired.length === 0) {
    return { ok: errors.length === 0, refreshed: [], errors };
  }

  const { inserted, closed, unchanged, perProvider } = await applyDesiredRows(db, desired);

  const now = new Date();
  for (const [provider, count] of perProvider) {
    await db
      .insert(schema.cliPricingSync)
      .values({
        name: provider,
        fetchedAt: now,
        fetchError: null,
        priceCount: count,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.cliPricingSync.name,
        set: { fetchedAt: now, fetchError: null, priceCount: count, updatedAt: now },
      });
  }

  log.info({ inserted, closed, unchanged }, 'refreshed model prices');
  return {
    ok: errors.length === 0,
    refreshed: [...perProvider].map(([name, count]) => ({
      name: `price:${name}`,
      count,
      latest: null,
    })),
    errors,
  };
}

/** Diff the desired rows against the live ones and write only what moved.
 *
 *  One transaction for the whole batch (a few hundred rows): the close and the insert
 *  of a changed rate must not be separable, or a crash between them leaves a model
 *  with no live row at all. A row the feed has STOPPED publishing is deliberately
 *  left open — a vendor dropping a model from its price list does not mean the model
 *  became free, and closing it would make every past invocation of it unpriceable. */
async function applyDesiredRows(
  db: Database,
  desired: DesiredRow[],
): Promise<{
  inserted: number;
  closed: number;
  unchanged: number;
  perProvider: Map<CliProviderName, number>;
}> {
  const sources = [...new Set(desired.map((d) => d.source))];
  const live = await db
    .select()
    .from(schema.cliModelPrices)
    .where(
      and(
        isNull(schema.cliModelPrices.effectiveTo),
        inArray(schema.cliModelPrices.source, sources),
      ),
    );
  const liveByKey = new Map(live.map((r) => [`${r.provider ?? ''} ${r.modelKey} ${r.source}`, r]));

  const toClose: string[] = [];
  const toInsert: DesiredRow[] = [];
  let unchanged = 0;
  for (const row of desired) {
    const existing = liveByKey.get(`${row.provider} ${row.modelKey} ${row.source}`);
    if (!existing) {
      toInsert.push(row);
      continue;
    }
    if (ratesEqual(existing.rates, row.rates)) {
      unchanged++;
      continue;
    }
    toClose.push(existing.id);
    toInsert.push(row);
  }

  if (toClose.length > 0 || toInsert.length > 0) {
    const now = new Date();
    await db.transaction(async (tx) => {
      // Close first: the partial unique index allows exactly one live row per
      // (provider, model, source), so the replacement cannot be inserted while the
      // superseded row is still open.
      for (let i = 0; i < toClose.length; i += 500) {
        await tx
          .update(schema.cliModelPrices)
          .set({ effectiveTo: now })
          .where(inArray(schema.cliModelPrices.id, toClose.slice(i, i + 500)));
      }
      for (let i = 0; i < toInsert.length; i += 500) {
        await tx.insert(schema.cliModelPrices).values(
          toInsert.slice(i, i + 500).map((row) => ({
            provider: row.provider,
            modelKey: row.modelKey,
            source: row.source,
            rates: row.rates,
            effectiveFrom: now,
          })),
        );
      }
    });
  }

  const perProvider = new Map<CliProviderName, number>();
  for (const row of desired) {
    perProvider.set(row.provider, (perProvider.get(row.provider) ?? 0) + 1);
  }
  return { inserted: toInsert.length, closed: toClose.length, unchanged, perProvider };
}

/** Record a fetch failure without touching stored rates or price counts. */
async function recordSyncError(
  db: Database,
  providers: CliProviderName[],
  error: string,
): Promise<void> {
  const now = new Date();
  for (const provider of providers) {
    await db
      .insert(schema.cliPricingSync)
      .values({ name: provider, fetchError: error, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.cliPricingSync.name,
        // Only the error moves — fetched_at and price_count keep describing the last
        // GOOD sync, which is what makes staleness visible instead of invisible.
        set: { fetchError: error, updatedAt: now },
      });
  }
}

/** Refresh today's FX rates from ECB's daily reference feed.
 *
 *  Upsert by (date, currency) so re-running is a no-op, and past rows are never
 *  rewritten: a finished task converts at the rate effective on ITS date, and ECB
 *  publishes only the current day — a row overwritten or deleted cannot be
 *  re-fetched. Same never-throw discipline as the price refresh.
 *
 *  Weekends and holidays legitimately return the previous business day's document;
 *  the upsert then simply re-affirms rows that already exist. */
export async function refreshFxRates(db: Database): Promise<RefreshCliVersionsJobResult> {
  try {
    const resp = await fetch(ECB_DAILY_FX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`${ECB_DAILY_FX_URL} HTTP ${resp.status}`);
    const { date, rates } = parseEcbDailyRates(await resp.text());
    // Zero matches means the document shape changed, which must never be read as "no
    // rates published today" — that would silently freeze every non-USD display.
    if (!date || rates.length === 0) throw new Error('ecb feed parsed to 0 rates');
    for (const rate of rates) {
      await db
        .insert(schema.fxRates)
        .values({ rateDate: date, currency: rate.currency, usdPerUnit: rate.usdPerUnit })
        .onConflictDoUpdate({
          target: [schema.fxRates.rateDate, schema.fxRates.currency],
          set: { usdPerUnit: rate.usdPerUnit },
        });
    }
    log.info({ date, count: rates.length }, 'refreshed fx rates');
    return { ok: true, refreshed: [{ name: 'fx', count: rates.length, latest: date }], errors: [] };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn({ error }, 'failed to refresh fx rates');
    return { ok: false, refreshed: [], errors: [{ name: 'fx', error }] };
  }
}
