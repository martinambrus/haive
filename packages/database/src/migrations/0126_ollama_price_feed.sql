-- Ollama Cloud is not free local compute: its own price feed, and the retirement of the
-- zero rates that said otherwise.
--
-- Haive treated every `ollama` invocation as free local compute. That was true when
-- `ollama` meant a local daemon and is not true of an install running Ollama Cloud, which
-- is plan-included up to a limit and metered beyond it. Two layers produced the wrong
-- number, and only the second is data:
--
-- 1. `costBasis: 'local'` on the ollama catalog entry, one value covering the local daemon
--    and Ollama Cloud alike. Now resolved per MODEL (`-cloud`/`:cloud` -> subscription) —
--    code, no data.
-- 2. Every LiteLLM `ollama` row is priced 0 and that 0 was STORED AS A RATE. A stored 0 is
--    not "unpriced", it is a PRICE: an invocation matching one records a real $0.00 cost,
--    the exact outcome the "an unmatched id is UNPRICED, never guessed" rule exists to
--    prevent. MEASURED on this install 2026-08-23: 21 such rows, all live, all rates 0,
--    FOUR of them CLOUD models (`deepseek-v3.1:671b-cloud`, `gpt-oss:20b-cloud`,
--    `gpt-oss:120b-cloud`, `qwen3-coder:480b-cloud`). Latent only by luck: no invocation
--    since model-identity capture began on 19 August has served any of the four, so none
--    of them ever matched. Every cloud model that DID run in that window (minimax-m3,
--    nemotron-3-ultra, glm-5.2) has no feed row at all, so those were honestly unpriced.
--
-- `ollama` is dropped from PROVIDER_LITELLM_VENDORS, so the sync stops PRODUCING those
-- rows. That alone does not retire them: `applyDesiredRows` deliberately leaves a row the
-- feed stopped publishing OPEN, because a vendor dropping a model from its price list does
-- not mean the model became free. Here it does mean exactly that, so this closes them.
--
-- Scoped by PROVENANCE (`source = 'litellm'`), not by value. Keying on "all rates are 0"
-- would also sweep up a deliberate manual 0 an admin entered, and would miss a non-zero
-- row from the same disowned feed. Every ollama row from that feed is stale by definition
-- now that the feed is no longer read for this provider.
--
-- CLOSED, never deleted: `cli_model_prices` is append-only because the rows that priced
-- past invocations must stay readable. Idempotent — the `effective_to IS NULL` predicate
-- makes a second run a no-op.
--
-- Deploy note: the enum value is applied by `drizzle-kit push --force` from the schema;
-- the UPDATE is not, and must be run once per environment. Safe in either order and safe
-- to run before the code deploy: closing these rows only moves ollama from a fake $0.00 to
-- honestly unpriced.
--
-- Rollback (data): reopen the rows this closed —
--   UPDATE "cli_model_prices" SET "effective_to" = NULL
--    WHERE "provider" = 'ollama' AND "source" = 'litellm' AND "effective_to" IS NOT NULL;
--   (safe only while no replacement row is live for the same (provider, model_key, source),
--    which holds as long as the litellm ollama vendor mapping stays dropped.)
--
-- Rollback (enum): Postgres cannot drop an enum value, so it needs a type recreate, and
-- only once no row references it —
--   DELETE FROM "cli_model_prices" WHERE "source" = 'ollama';
--   UPDATE "cli_pricing_sync" SET "preferred_feed" = NULL WHERE "preferred_feed" = 'ollama';
--   ALTER TYPE "price_feed" RENAME TO "price_feed_old";
--   CREATE TYPE "price_feed" AS ENUM ('openrouter','litellm','manual');
--   ALTER TABLE "cli_model_prices" ALTER COLUMN "source" TYPE "price_feed" USING "source"::text::"price_feed";
--   ALTER TABLE "cli_pricing_sync" ALTER COLUMN "preferred_feed" TYPE "price_feed" USING "preferred_feed"::text::"price_feed";
--   DROP TYPE "price_feed_old";

ALTER TYPE "price_feed" ADD VALUE IF NOT EXISTS 'ollama';

UPDATE "cli_model_prices"
   SET "effective_to" = now()
 WHERE "provider" = 'ollama'
   AND "source" = 'litellm'
   AND "effective_to" IS NULL;
