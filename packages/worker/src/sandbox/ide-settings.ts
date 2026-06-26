import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

// The default global code-server settings.json seeded into a new user-data volume.
// Minimal and uncontroversial: telemetry off (code-server already has --disable-
// telemetry, this is belt-and-suspenders for the workbench). Slice 6 replaces this
// with the user's DB-backed settings, edited from the settings page.
const DEFAULT_IDE_SETTINGS = JSON.stringify(
  {
    'telemetry.telemetryLevel': 'off',
  },
  null,
  2,
);

/** Resolve a user's global code-server settings.json (a JSON string), seeded into
 *  the IDE user-data volume at launch. Reads the per-user DB store (edited from the
 *  settings page); falls back to the minimal default when the user has no row. */
export async function resolveIdeSettingsJson(db: Database, userId: string): Promise<string> {
  const row = await db.query.userIdeSettings.findFirst({
    where: eq(schema.userIdeSettings.userId, userId),
    columns: { settingsJson: true },
  });
  return row?.settingsJson ?? DEFAULT_IDE_SETTINGS;
}
