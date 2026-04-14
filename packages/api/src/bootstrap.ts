import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase } from './db.js';
import { initRedis } from './redis.js';

export interface BootstrapResult {
  databaseUrl: string;
  redisUrl: string;
  apiPort: number;
  webOrigin: string;
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

  // Eagerly bootstrap JWT signing secret + email pepper.
  await secretsService.getJwtSecret();
  await secretsService.getEmailBlindIndexPepper();

  const apiPort = await configService.getNumber('config:server:apiPort', 3001);
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

  logger.info({ apiPort, webOrigin }, 'API bootstrap complete');
  return { databaseUrl, redisUrl, apiPort, webOrigin };
}
