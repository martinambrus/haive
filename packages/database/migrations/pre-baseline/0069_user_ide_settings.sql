-- Per-user global code-server (Editor tab) settings.json store. One row per user;
-- absent row = built-in default. Idempotent.
CREATE TABLE IF NOT EXISTS "user_ide_settings" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "settings_json" text NOT NULL DEFAULT '{}',
  "updated_at" timestamp NOT NULL DEFAULT now()
);
