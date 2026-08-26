import { boolean, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './auth.js';

/** Per-user task-attention notification preferences. One row per user; an
 *  absent row means defaults (sound enabled, built-in chime). sound_path
 *  points at the uploads volume:
 *    {REPO_STORAGE_ROOT}/_uploads/{userId}/notification-sound.<ext>
 *  sound_path / sound_mime / sound_filename are set together by the
 *  sound-upload endpoint and nulled together on delete. */
export const userNotificationSettings = pgTable('user_notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  soundEnabled: boolean('sound_enabled').notNull().default(true),
  /** Per-user opt-out for subscription usage-depletion alerts (the global
   *  enable + threshold live in config as USAGE_ALERT_*). Default on. */
  usageAlertEnabled: boolean('usage_alert_enabled').notNull().default(true),
  soundPath: text('sound_path'),
  soundMime: varchar('sound_mime', { length: 64 }),
  soundFilename: varchar('sound_filename', { length: 255 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Per-user global code-server (Editor tab) settings: the JSON written to the IDE
 *  user-data settings.json at launch. One row per user; an absent row means the
 *  built-in default. Per-repo overrides live in the repo's .vscode/settings.json,
 *  which VS Code layers on top of these. */
export const userIdeSettings = pgTable('user_ide_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  settingsJson: text('settings_json').notNull().default('{}'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

/** Per-user UI preferences as one JSON blob — view choice and pane split for the
 *  plan canvas today. Per USER (not per repo, not per browser): a layout choice
 *  is about how a person reads plans. Schemaless on the server; the web owns the
 *  keys, so a new pref is a web-only change. Same shape as user_ide_settings. */
export const userUiPrefs = pgTable('user_ui_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  settingsJson: text('settings_json').notNull().default('{}'),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
