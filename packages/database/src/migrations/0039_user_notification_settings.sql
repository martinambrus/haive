-- Task-attention notification preferences: per-user sound on/off plus an
-- optional custom sound file stored on the haive_repos uploads volume at
-- {REPO_STORAGE_ROOT}/_uploads/{user_id}/notification-sound.<ext>. Row
-- absent = defaults (sound enabled, built-in chime).
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "user_notification_settings";
CREATE TABLE IF NOT EXISTS "user_notification_settings" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "sound_enabled" boolean NOT NULL DEFAULT true,
  "sound_path" text,
  "sound_mime" varchar(64),
  "sound_filename" varchar(255),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
