import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { waitForDatabaseReady } from '@haive/database';
import { initDatabase } from './db.js';
import { initRedis } from './redis.js';
import {
  editorOrigin,
  publicApiOrigin,
  webOrigin as resolveWebOrigin,
} from './lib/request-origin.js';

export interface BootstrapResult {
  databaseUrl: string;
  redisUrl: string;
  apiPort: number;
  webOrigin: string;
}

export async function bootstrap(): Promise<BootstrapResult> {
  editorOrigin(); // Validate the optional operator setting before opening connections.
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

  // Eagerly bootstrap JWT signing secret + email pepper.
  await secretsService.getJwtSecret();
  await secretsService.getEmailBlindIndexPepper();

  const apiPort = await configService.getNumber('config:server:apiPort', 3001);
  const webOrigin = resolveWebOrigin();

  warnCrossHostProxyThrottle(webOrigin);

  logger.info({ apiPort, webOrigin }, 'API bootstrap complete');
  return { databaseUrl, redisUrl, apiPort, webOrigin };
}

/** The public web URL may name a front proxy, not the web process's outbound peer.
 * DNS or a fixed compose service cannot reliably establish trusted-proxy coverage.
 * Diagnose only an empty list, once after bootstrap's retried work has succeeded. */
function warnCrossHostProxyThrottle(web: string): void {
  const api = publicApiOrigin(web);
  if (api === null) return;
  let viaWebProxy: boolean;
  try {
    viaWebProxy = new URL(api).hostname !== new URL(web).hostname;
  } catch {
    return;
  }
  const hasTrustedProxies = (process.env.HAIVE_TRUSTED_PROXIES ?? '')
    .split(',')
    .some((entry) => entry.trim() !== '');
  if (!viaWebProxy || hasTrustedProxies) return;
  logger.warn(
    { rule: 'docs/architecture/api-auth.md', section: 'Cross-host web-proxy mode' },
    'Cross-host web-proxy mode has no HAIVE_TRUSTED_PROXIES; review the sign-in throttle operator rule',
  );
}
