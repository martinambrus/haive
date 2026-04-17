import { mkdir } from 'node:fs/promises';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  CONFIG_KEYS,
} from '@haive/shared';
import { initDatabase } from './db.js';
import { initRedis } from './redis.js';

export interface BootstrapResult {
  databaseUrl: string;
  redisUrl: string;
  repoStoragePath: string;
}

export async function bootstrap(): Promise<BootstrapResult> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!redisUrl) throw new Error('REDIS_URL is required');

  initRedis(redisUrl);
  await configService.initialize(redisUrl);

  const db = initDatabase(databaseUrl);
  await secretsService.initialize(db);

  const masterKek = await secretsService.getMasterKek();
  await userSecretsService.initialize(db, masterKek);

  const repoStoragePath =
    process.env.REPO_STORAGE_ROOT ??
    (await configService.get(CONFIG_KEYS.REPO_STORAGE_PATH)) ??
    '/var/lib/haive/repos';
  await mkdir(repoStoragePath, { recursive: true });

  logger.info({ repoStoragePath }, 'Worker bootstrap complete');
  return { databaseUrl, redisUrl, repoStoragePath };
}
