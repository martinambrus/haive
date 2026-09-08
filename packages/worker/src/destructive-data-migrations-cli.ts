#!/usr/bin/env node
/**
 * Run the DESTRUCTIVE data migrations, once, and exit.
 *
 * Deliberately not part of any boot path. Boot happens before an upgrade has been verified, and
 * these remove rows with no tombstone — one of them deletes from the global KB store, a separate
 * database that the pre-migration snapshot does not cover. Running them before the health gate
 * would mean a rollback restores the previous images onto data the new version already destroyed.
 *
 * Invoked by `@haive/updater` at its commit phase, from the TARGET release's worker image, after
 * the gate has passed and the upgrade is being kept. Safe to re-run: every entry is idempotent,
 * which is what lets an interrupted commit simply repeat.
 */
import { configService, logger } from '@haive/shared';
import { initDatabase } from './db.js';
import { runDestructiveDataMigrations } from './data-migrations.js';

const log = logger.child({ module: 'destructive-data-migrations-cli' });

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!redisUrl) throw new Error('REDIS_URL is required');

  // configService, because at least one entry is flag-gated and reads its switch from Redis.
  await configService.initialize(redisUrl);
  const db = initDatabase(databaseUrl);

  await runDestructiveDataMigrations(db);
  log.info('destructive data migrations complete');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  log.error({ err }, 'destructive data migrations failed');
  process.exit(1);
}
