import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';

const log = logger.child({ module: 'data-migrations' });

/**
 * Idempotent data fixes applied on every worker boot. Each helper must be
 * narrow, fast, and a no-op on a clean DB so that re-running on every restart
 * costs nothing.
 */
export async function runDataMigrations(db: Database): Promise<void> {
  await migrateLegacyZaiAuthMode(db);
}

/**
 * Z.AI ships no standalone login subcommand. Provider rows created while the
 * zai catalog still advertised `supportsCliAuth=true` were saved with
 * `auth_mode='subscription'` (or 'mixed'), which the dispatcher now refuses
 * because the adapter no longer offers a CLI path. Flip those rows to
 * `api_key` so the dispatcher picks the only path that ever worked.
 */
async function migrateLegacyZaiAuthMode(db: Database): Promise<void> {
  const updated = await db
    .update(schema.cliProviders)
    .set({ authMode: 'api_key', updatedAt: new Date() })
    .where(
      and(
        eq(schema.cliProviders.name, 'zai'),
        inArray(schema.cliProviders.authMode, ['subscription', 'mixed']),
      ),
    )
    .returning({ id: schema.cliProviders.id });
  if (updated.length > 0) {
    log.info(
      { count: updated.length, ids: updated.map((r) => r.id) },
      'migrated legacy zai providers from CLI auth to api_key',
    );
  }
}
