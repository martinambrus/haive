-- Per-(user, step[, role]) effort/reasoning-level override, stored beside the
-- remembered CLI in the step-CLI preference tables. NULL = no override (the step
-- falls back to the provider's configured effortLevel, then the adapter's max).
-- The value is validated against the resolved provider's effortScale at save and
-- at dispatch, so a stale level (e.g. claude 'max' after switching the step to
-- codex, which has no 'max') is dropped rather than passed to the CLI.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "user_step_cli_preferences" ADD COLUMN IF NOT EXISTS "effort_level" text;
ALTER TABLE "user_step_cli_role_preferences" ADD COLUMN IF NOT EXISTS "effort_level" text;
