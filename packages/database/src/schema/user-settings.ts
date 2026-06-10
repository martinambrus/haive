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
  soundPath: text('sound_path'),
  soundMime: varchar('sound_mime', { length: 64 }),
  soundFilename: varchar('sound_filename', { length: 255 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
