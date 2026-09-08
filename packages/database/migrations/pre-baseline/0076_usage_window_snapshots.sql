-- Subscription usage-window snapshots: one live row per CLI provider, refreshed
-- by the gentle usage poller. Percent values are 0-100 CONSUMED; a null window
-- means the vendor does not expose it. Disposable cache (provider-keyed upsert).
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
CREATE TABLE IF NOT EXISTS "usage_window_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "cli_providers"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider_name" varchar(64) NOT NULL,
  "five_hour_pct" integer,
  "five_hour_reset_at" timestamp,
  "seven_day_pct" integer,
  "seven_day_reset_at" timestamp,
  "daily_pct" integer,
  "daily_reset_at" timestamp,
  "status" varchar(16) DEFAULT 'ok' NOT NULL,
  "error_message" text,
  "fetched_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_window_provider_idx" ON "usage_window_snapshots" ("provider_id");
CREATE INDEX IF NOT EXISTS "usage_window_user_idx" ON "usage_window_snapshots" ("user_id");
