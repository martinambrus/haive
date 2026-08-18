-- Per-model API pricing: effective-dated rates, daily FX, per-provider sync state,
-- and a per-invocation cost snapshot.
--
-- WHY. Haive records token usage per invocation and (since 0119) which model answered,
-- but not what a token costs, so almost no spend is reportable. MEASURED on live data
-- before this migration: of ~12,800 USD of CLI-reported cost across 12,438 invocations,
-- 31.68 USD was the only amount the product could show as real. The rest is refused for
-- good reasons — claude-code/codex run on flat subscriptions, and the claude binary
-- prices EVERY run against Anthropic's table regardless of which backend answered, so
-- for zai/muse/openrouter/ollama its `total_cost_usd` is fiction (see the costBasis
-- notes in @haive/shared cli-providers/catalog.ts). codex and gemini report no cost at
-- all. Pricing the four token buckets from a real rate table is the only way those
-- providers ever show real money.
--
--
-- cli_model_prices — append-only, effective-dated rates.
--
--   Append-only rather than a mutable current-price table because two different
--   questions need answering: "what does this model cost now" (the live row) and "what
--   did this model cost when that task ran" (the row live at the time). A sync closes
--   the live row (effective_to = now()) and inserts a replacement ONLY when a rate
--   actually moved, so an unchanged 12-hourly refresh writes nothing and the history
--   does not grow one row per tick.
--
--   provider NULL = vendor-wide: the rate applies to that model id wherever served. A
--   provider-scoped row wins for the same model, since it was entered about that exact
--   endpoint. Ordering among several live rows is `pickLivePrice` in @haive/shared:
--   manual first, then the provider's preferred feed, then the rest, newest
--   effective_from breaking a tie. Two feeds are never averaged — an average is a
--   number no vendor charges.
--
--   model_key is the model id normalized to trim + lowercase and NOTHING else. Variant
--   markers are KEPT (`glm-5.3[1m]`, `deepseek-v4-pro:cloud`, `gpt-5.6-sol`) because a
--   context or hosting variant is frequently its own SKU at its own price. Lookup is
--   EXACT, unlike the longest-substring matcher used for context windows: a wrong
--   context window skews a cosmetic percentage, a wrong price is wrong money, and
--   `claude` alone would match both opus and haiku — roughly 15x apart. An id that
--   matches nothing is reported UNPRICED, never guessed.
--
--   rates is one jsonb, not five numeric columns, for the same reason as token_usage
--   and model_identity: the set is read whole, never filtered or joined on, and is only
--   meaningful as a group (an input rate without its cache rates cannot price an
--   invocation). Every bucket is independently nullable and a NULL must never be read
--   as 0 — a displayed 0 reads as "free", which is the one wrong answer that costs
--   money.
--
--   Partial unique index: at most one LIVE row per (provider, model_key, source). Two
--   feeds MAY each hold a live row for one model; one feed must never hold two.
--
--
-- cli_pricing_sync — one row per provider name.
--
--   Same single-row-keyed-by-name shape as cli_package_versions and
--   openrouter_model_cache, and refreshed by the same REFRESH_VERSIONS job. Unlike
--   those two it is NOT purely a cache: auto_update_enabled is user intent (an
--   enterprise on negotiated rates turns it off and enters its own rates), so
--   truncating this table loses a setting rather than just a cache. Seeded
--   enabled-for-all here, which reproduces the pre-migration behaviour of "no manual
--   rates exist anywhere".
--
--
-- fx_rates — daily USD-per-unit, from ECB's euro reference feed.
--
--   Stored dated and never overwritten, because a display currency is presentation but
--   a historical report must be reproducible: a finished task converts at the rate
--   effective on ITS date, so re-rendering it next month yields the same figure.
--   Stored USD-per-unit (derived from the EUR-quoted feed) so each conversion is one
--   division against the canonical USD amount. Disposable for TODAY only — ECB
--   publishes just the current day, so a deleted past row cannot be re-fetched. Do not
--   truncate.
--
--
-- cli_invocations.cost — the number the product may show, and where it came from.
--
--   Deliberately NOT folded into token_usage. token_usage.costUsd keeps its existing
--   meaning ("what the CLI reported") so the three aggregations in
--   api/routes/tasks/_helpers.ts cannot regress, and reads fall back to them for every
--   row written before this column existed. Those legacy rows are why grok's real
--   31.68 USD stays visible.
--
--   A snapshot: `rates` and `priceRowId` pin the price in force at run time. Recomputing
--   a finished task from the live table would silently restate history.
--
--   `billable` is decided at WRITE time, where provider, auth mode, model and price
--   source are all in hand, instead of being re-derived by every read query — which is
--   how three separate SQL filters came to duplicate the same rule. False for a
--   subscription plan (flat fee, so per-token dollars are notional) and for
--   source 'none'.
--
--   Shape (kept in sync with `InvocationCost` in @haive/shared):
--     { costUsd, currency, source, billable, modelKey, priceRowId, rates, cacheTtl,
--       unpricedBuckets[] }
--   source is 'manual' | 'reported' | 'computed' | 'none'. No NOT NULL and no default:
--   NULL means the cost pass did not run (legacy row, best-effort failure), which is a
--   different fact from "this invocation cost nothing", and a default would fabricate
--   the second.
--
--
-- Additive and idempotent throughout: a second run is a no-op, existing rows keep their
-- current behaviour (cost stays NULL, so every read uses the legacy path), and no code
-- reads any of this until the later slices land. Leaving the tables in place after a code
-- revert is harmless.
--
-- Rollback:
--   ALTER TABLE "cli_invocations" DROP COLUMN IF EXISTS "cost";
--   DROP TABLE IF EXISTS "cli_model_prices";
--   DROP TABLE IF EXISTS "cli_pricing_sync";
--   DROP TABLE IF EXISTS "fx_rates";
--   DROP TYPE IF EXISTS "price_feed";
--   Reverting restores today's numbers exactly, because token_usage.costUsd and the
--   aggregations over it are untouched. The only loss is the collected price history,
--   which the feeds cannot republish — so prefer disabling the sync over dropping the
--   table if the intent is just to stop updating.

DO $$ BEGIN
  CREATE TYPE "price_feed" AS ENUM ('openrouter', 'litellm', 'manual');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cli_model_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" "cli_provider_name",
  "model_key" text NOT NULL,
  "source" "price_feed" NOT NULL,
  "rates" jsonb NOT NULL,
  "currency" varchar(3) DEFAULT 'USD' NOT NULL,
  "note" text,
  "effective_from" timestamp DEFAULT now() NOT NULL,
  "effective_to" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "cli_model_prices_live_idx"
  ON "cli_model_prices" ("provider", "model_key", "source")
  WHERE "effective_to" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "cli_model_prices_lookup_idx"
  ON "cli_model_prices" ("model_key", "effective_from");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "cli_pricing_sync" (
  "name" "cli_provider_name" PRIMARY KEY NOT NULL,
  "auto_update_enabled" boolean DEFAULT true NOT NULL,
  "preferred_feed" "price_feed",
  "fetched_at" timestamp,
  "fetch_error" text,
  "price_count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "fx_rates" (
  "rate_date" date NOT NULL,
  "currency" varchar(3) NOT NULL,
  "usd_per_unit" double precision NOT NULL,
  "source" varchar(16) DEFAULT 'ecb' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fx_rates_date_currency_idx"
  ON "fx_rates" ("rate_date", "currency");
--> statement-breakpoint

ALTER TABLE "cli_invocations" ADD COLUMN IF NOT EXISTS "cost" jsonb;
--> statement-breakpoint

-- Seed one sync row per provider, auto-update on. Idempotent: an existing row keeps
-- whatever the admin set. Enumerated from the cli_provider_name enum itself rather than
-- a hand-written list, so a provider added by a later migration is picked up by re-running
-- this statement instead of being silently missed.
INSERT INTO "cli_pricing_sync" ("name")
SELECT unnest(enum_range(NULL::"cli_provider_name"))
ON CONFLICT ("name") DO NOTHING;
