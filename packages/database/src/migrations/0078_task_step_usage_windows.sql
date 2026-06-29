-- Surface B revision: subscription-allowance USED% frozen on a step when it
-- finishes, alongside the existing context-window columns, so each finished step
-- shows a historical stamp of the 5-hour / weekly / daily allowance (the UI renders
-- remaining = 100 - used). Captured from the usage_window_snapshots row of the
-- step's CLI provider. All nullable: null on deterministic (no-CLI) steps, when
-- usage tracking is not connected for the provider, and on rows finalized before
-- this feature.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "usage_five_hour_pct" integer;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "usage_seven_day_pct" integer;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "usage_daily_pct" integer;
