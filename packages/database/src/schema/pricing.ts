import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  jsonb,
  date,
  timestamp,
  uniqueIndex,
  index,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { cliProviderNameEnum } from './cli-providers.js';

/** Where a stored rate came from. Keep in sync with `PriceFeed` in @haive/shared
 *  (this package cannot import shared — shared imports database, not the reverse).
 *
 *  `ollama` is its own feed rather than a LiteLLM row because Ollama publishes no
 *  price document at all: the only rates it states anywhere are on the individual
 *  model pages, scraped one page per configured cloud model. */
export const priceFeedEnum = pgEnum('price_feed', ['openrouter', 'litellm', 'manual', 'ollama']);

// --- Effective-dated model prices ---------------------------------------

/** Per-model token rates, effective-dated.
 *
 *  Append-only history rather than a mutable current-price table: a task finished
 *  last month has to keep reporting the price that applied then, and the same rows
 *  are what a future global-stats page charts as price-over-time. A sync CLOSES the
 *  live row (effective_to = now) and inserts a new one only when a rate actually
 *  moved, so an unchanged 12-hourly refresh writes nothing.
 *
 *  `provider` NULL means vendor-wide: the rate applies to that model id wherever it
 *  is served. A provider-scoped row wins for the same model, since it was entered
 *  about that exact endpoint (see `pickLivePrice` in @haive/shared).
 *
 *  Rates live in one jsonb rather than five numeric columns for the same reason as
 *  token_usage and model_identity next door: the set is read whole, never filtered
 *  or joined on, and it is only meaningful as a group — an input rate without its
 *  cache rates cannot price an invocation. Each bucket is independently nullable and
 *  a null must never be read as 0; a displayed 0 reads as "free". */
export const cliModelPrices = pgTable(
  'cli_model_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL = applies to this model id under any provider. */
    provider: cliProviderNameEnum('provider'),
    /** Normalized model id (trim + lowercase, otherwise verbatim). Variant markers
     *  are KEPT — `glm-5.3[1m]` and `deepseek-v4-pro:cloud` are their own SKUs at
     *  their own prices. */
    modelKey: text('model_key').notNull(),
    source: priceFeedEnum('source').notNull(),
    /** Keep in sync with `ModelPriceRates` in @haive/shared. USD per single token. */
    rates: jsonb('rates')
      .$type<{
        inputRate: number | null;
        outputRate: number | null;
        cacheReadRate: number | null;
        cacheWriteRate: number | null;
        cacheWrite1hRate: number | null;
      }>()
      .notNull(),
    /** Always 'USD': every vendor bills USD, and a display currency is applied at
     *  read time from `fx_rates`. Stored so a future non-USD-billing vendor does not
     *  need a migration to be representable. */
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    /** Free-text provenance for a manual row (who negotiated it, contract ref). */
    note: text('note'),
    effectiveFrom: timestamp('effective_from').notNull().defaultNow(),
    /** NULL = this is the live rate. */
    effectiveTo: timestamp('effective_to'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // At most one LIVE row per (provider, model, source). Two feeds may each hold a
    // live row for one model — that is intended, and `pickLivePrice` orders them —
    // but one feed must never hold two.
    uniqueIndex('cli_model_prices_live_idx')
      .on(table.provider, table.modelKey, table.source)
      .where(sql`${table.effectiveTo} is null`),
    index('cli_model_prices_lookup_idx').on(table.modelKey, table.effectiveFrom),
  ],
);

// --- Per-provider sync state --------------------------------------------

/** One row per CLI provider name: whether the price sync may touch it, which feed
 *  it prefers, and how the last fetch went.
 *
 *  Same single-row-keyed-by-name shape as `cli_package_versions` and
 *  `openrouter_model_cache`, refreshed by the same REFRESH_VERSIONS job. Distinct
 *  from a cache in one way that matters: `auto_update_enabled` is USER intent (an
 *  enterprise on negotiated rates turns it off and enters its own), so truncating
 *  this table loses a setting, not just a cache. */
export const cliPricingSync = pgTable('cli_pricing_sync', {
  name: cliProviderNameEnum('name').primaryKey(),
  /** False = this provider's rates are admin-owned; the sync skips it entirely. */
  autoUpdateEnabled: boolean('auto_update_enabled').notNull().default(true),
  /** Which feed's row wins when several price the same model. NULL = no preference. */
  preferredFeed: priceFeedEnum('preferred_feed'),
  fetchedAt: timestamp('fetched_at'),
  fetchError: text('fetch_error'),
  /** How many live rates this provider resolved to on the last sync — lets the admin
   *  page distinguish "synced, nothing matched" from "never synced". */
  priceCount: integer('price_count').notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// --- FX ------------------------------------------------------------------

/** Daily USD-per-unit rates, from ECB's euro reference feed.
 *
 *  Stored dated and never overwritten: a display currency is presentation, but a
 *  historical report has to be reproducible, so a finished task converts at the rate
 *  effective on ITS date rather than today's. Rates are stored USD-per-unit
 *  (derived from the EUR-quoted feed) so every conversion is one division against
 *  the canonical USD amount.
 *
 *  A pure cache in the disposable sense — refetching rebuilds today's row — but not
 *  in the historical sense: ECB publishes only the current day, so a deleted past
 *  row cannot be recovered from the feed. Do not truncate. */
export const fxRates = pgTable(
  'fx_rates',
  {
    rateDate: date('rate_date').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    usdPerUnit: doublePrecision('usd_per_unit').notNull(),
    source: varchar('source', { length: 16 }).notNull().default('ecb'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('fx_rates_date_currency_idx').on(table.rateDate, table.currency)],
);
