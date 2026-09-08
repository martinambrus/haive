-- Cache of OpenRouter's own model catalog (GET https://openrouter.ai/api/v1/models),
-- so the provider form can offer a picker instead of a free-text slug. OpenRouter
-- fronts 400+ models, so a typo in a hand-typed slug is a 404 that only surfaces on
-- the first run.
--
-- Same shape as cli_package_versions (single row keyed by provider name, list in
-- jsonb, fetched_at/fetch_error) because it is refreshed wholesale by the same
-- REFRESH_VERSIONS job and nothing joins against individual models. Only the fields
-- the picker and the context-window lookup read are stored; the raw payload is ~4 MB
-- of mostly prose.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file is
-- the idempotent parity/rollback record.
--
-- Rollback (safe unconditionally — this is a CACHE, and the next refresh rebuilds it;
-- no other table references it and no code treats it as a source of truth):
--   DROP TABLE IF EXISTS "openrouter_model_cache";
CREATE TABLE IF NOT EXISTS "openrouter_model_cache" (
  "name" "cli_provider_name" PRIMARY KEY NOT NULL,
  "models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "fetched_at" timestamp,
  "fetch_error" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
