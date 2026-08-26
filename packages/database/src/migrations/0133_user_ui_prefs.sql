-- Per-user UI preferences (view choice, pane split, ...) as one JSON blob.
--
-- Deliberately per USER, not per repository and not per browser: a layout choice
-- is about how a person reads plans, and it should follow them across repos and
-- machines. Schemaless on the server — the web owns the keys, so a new pref is a
-- web-only change and old rows simply lack it. Same shape as user_ide_settings.
--
-- Additive and idempotent. Rollback: DROP TABLE user_ui_prefs — nothing else
-- references it and the data is cosmetic.
CREATE TABLE IF NOT EXISTS "user_ui_prefs" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "settings_json" text NOT NULL DEFAULT '{}',
  "updated_at" timestamp NOT NULL DEFAULT now()
);
