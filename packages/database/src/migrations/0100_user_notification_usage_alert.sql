-- Per-user opt-out for subscription usage-depletion alerts. The web notifier warns once
-- per provider per usage window per reset when that window's REMAINING allowance falls to
-- or below the global USAGE_ALERT_THRESHOLD_PCT. Admin owns the global enable + threshold
-- (config keys), but noise tolerance is personal, so each user gets a switch of their own —
-- mirroring the existing sound_enabled preference on this same table. Defaults to true so
-- existing users are opted in without a backfill.
-- Additive + idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "user_notification_settings" ADD COLUMN IF NOT EXISTS "usage_alert_enabled" boolean NOT NULL DEFAULT true;
