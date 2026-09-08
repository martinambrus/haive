-- Per-(user, step, role) CLI provider preference for multi-CLI steps (e.g.
-- spec-quality's reviewer/corrector). Additive: the single-provider
-- user_step_cli_preferences table is unchanged and remains the `default` role.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "user_step_cli_role_preferences";
CREATE TABLE IF NOT EXISTS "user_step_cli_role_preferences" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "step_id" varchar(128) NOT NULL,
  "role" varchar(32) NOT NULL,
  "cli_provider_id" uuid NOT NULL REFERENCES "cli_providers"("id") ON DELETE CASCADE,
  "explicit" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_step_cli_role_pref_pk"
  ON "user_step_cli_role_preferences" ("user_id", "step_id", "role");
