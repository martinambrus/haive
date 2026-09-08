import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import {
  getHaiveVersion,
  isDevVersion,
  logger,
  WORKER_RUNTIME_VERSION_KEY,
  type WorkerRuntimeVersion,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import type { AppEnv } from '../context.js';

/**
 * What is actually running.
 *
 * UNAUTHENTICATED, alongside `/health`, and that is a requirement rather than an oversight: an
 * upgrade has to verify the new containers came up at the target version, and it does so before
 * — and without — any credential. `/health` already sits here for the same reason. The disclosure
 * is the version of a self-hosted install to someone who can already reach its API.
 *
 * `/health` cannot answer this. It returns a fixed `{status, service}` and would report `ok` from
 * a container running the PREVIOUS image, which is precisely the half-upgraded state the health
 * gate exists to catch.
 */
export const versionRoutes = new Hono<AppEnv>();

versionRoutes.get('/', async (c) => {
  const version = getHaiveVersion();

  // The highest applied migration. The upgrade needs this to tell "the new image booted" from
  // "the new image booted AND its migrations landed" — a distinction `/health` cannot make.
  let migrationHead: string | null = null;
  try {
    const rows = await getDb().execute<{ id: string }>(
      sql`SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
    );
    migrationHead = (rows as unknown as { id: string }[])[0]?.id ?? null;
  } catch (err) {
    // A database with no journal yet is a legitimate state (nothing has migrated it), not an
    // error worth failing the endpoint over — the caller reads `null` and knows.
    logger.debug({ err }, 'version: could not read migration head');
  }

  // The worker has no HTTP surface, so it publishes its own boot at a well-known key. Reported
  // verbatim, including a stale one: a worker that failed to restart leaves the OLD version and
  // an old `startedAt`, and that is the evidence an upgrade gate wants, not something to hide.
  let worker: WorkerRuntimeVersion | null = null;
  try {
    const raw = await getRedis().get(WORKER_RUNTIME_VERSION_KEY);
    if (raw) worker = JSON.parse(raw) as WorkerRuntimeVersion;
  } catch (err) {
    logger.debug({ err }, 'version: could not read worker runtime version');
  }

  return c.json({
    service: 'haive-api',
    version,
    devBuild: isDevVersion(version),
    migrationHead,
    worker,
  });
});
