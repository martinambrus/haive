-- Per-user, per-step CLI provider preferences. Step-runner picks the CLI
-- via this map first (with a fallback to task-level cliProviderId). The
-- UI's per-step dropdown writes to this table. Worker also auto-records
-- the last-actually-used provider on every CLI dispatch.

CREATE TABLE "user_step_cli_preferences" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "step_id" varchar(128) NOT NULL,
  "cli_provider_id" uuid NOT NULL REFERENCES "cli_providers"("id") ON DELETE CASCADE,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "user_step_cli_pref_pk"
  ON "user_step_cli_preferences" ("user_id", "step_id");
