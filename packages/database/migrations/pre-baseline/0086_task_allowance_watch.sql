-- Allowance-back watch (notify-only): when a task fails on a provider rate-limit/quota
-- (ProviderFatalClass.rate_limit) for a usage-readable CLI, the worker arms a silent watch
-- on the task row; the gentle usage poller stamps allowance_replenished_at once the
-- depleted window resets (or its consumed % falls), and the web notifier diffs that
-- null->set flip into an "allowance is back — ready to retry" browser notification.
-- All three columns are nullable and default to no-watch, so existing tasks/fixtures are
-- unaffected. Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "awaiting_allowance_provider_id" uuid REFERENCES "cli_providers"("id") ON DELETE SET NULL;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "allowance_reset_at" timestamp;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "allowance_replenished_at" timestamp;
