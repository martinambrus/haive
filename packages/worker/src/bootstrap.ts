import { mkdir } from 'node:fs/promises';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  CONFIG_KEYS,
  getHaiveVersion,
  WORKER_RUNTIME_VERSION_KEY,
  type WorkerRuntimeVersion,
} from '@haive/shared';
import { waitForDatabaseReady } from '@haive/database';
import { initDatabase } from './db.js';
import { initRedis, getRedis } from './redis.js';
import { runDataMigrations } from './data-migrations.js';
import { syncTemplateManifestCache } from './step-engine/template-manifest.js';

export interface BootstrapResult {
  databaseUrl: string;
  redisUrl: string;
  repoStoragePath: string;
  bundleStoragePath: string;
}

export async function bootstrap(): Promise<BootstrapResult> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!redisUrl) throw new Error('REDIS_URL is required');

  initRedis(redisUrl);
  await configService.initialize(redisUrl);

  const db = initDatabase(databaseUrl);
  await waitForDatabaseReady(db, {
    onRetry: ({ attempt, waitedMs, reason }) =>
      logger.warn({ attempt, waitedMs, reason }, 'database not ready, retrying'),
  });
  await secretsService.initialize(db);

  const masterKek = await secretsService.getMasterKek();
  await userSecretsService.initialize(db, masterKek);

  const repoStoragePath =
    process.env.REPO_STORAGE_ROOT ??
    (await configService.get(CONFIG_KEYS.REPO_STORAGE_PATH)) ??
    '/var/lib/haive/repos';
  await mkdir(repoStoragePath, { recursive: true });

  const bundleStoragePath = process.env.BUNDLE_STORAGE_ROOT ?? '/var/lib/haive/bundles';
  await mkdir(bundleStoragePath, { recursive: true });

  await syncTemplateManifestCache(db);
  await runDataMigrations(db);

  // Publish what this worker is running, so `GET /version` on the api can report both services.
  // Best-effort: failing to advertise a version must never stop the worker from doing its job.
  try {
    const runtime: WorkerRuntimeVersion = {
      version: getHaiveVersion(),
      startedAt: new Date().toISOString(),
    };
    await getRedis().set(WORKER_RUNTIME_VERSION_KEY, JSON.stringify(runtime));
  } catch (err) {
    logger.warn({ err }, 'could not publish worker runtime version');
  }

  logger.info({ repoStoragePath, bundleStoragePath }, 'Worker bootstrap complete');
  return { databaseUrl, redisUrl, repoStoragePath, bundleStoragePath };
}
