-- Per-step CLI overrides are now explicit-only. The worker no longer
-- auto-records the last-used provider after each CLI dispatch, so the
-- task-level cliProviderId is honored for every step unless the user sets
-- an explicit per-step override via the task UI. Pre-existing auto-recorded
-- rows default to explicit=false and are ignored by the runner and the UI.
--
-- Rollback: ALTER TABLE "user_step_cli_preferences" DROP COLUMN "explicit";
ALTER TABLE "user_step_cli_preferences"
  ADD COLUMN IF NOT EXISTS "explicit" boolean NOT NULL DEFAULT false;
