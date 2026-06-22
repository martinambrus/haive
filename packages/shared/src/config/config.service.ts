import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { createRedisConnection } from '../utils/redis-factory.js';
import { logger } from '../logger/index.js';

export const CONFIG_KEYS = {
  DATABASE_URL: 'config:database:url',
  API_PORT: 'config:server:apiPort',

  JWT_ACCESS_TTL: 'config:jwt:accessTtl',
  JWT_REFRESH_TTL: 'config:jwt:refreshTtl',

  RATE_LIMIT_API_RPM: 'config:rateLimit:api:requestsPerMinute',
  RATE_LIMIT_AUTH_RPM: 'config:rateLimit:auth:requestsPerMinute',

  SMTP_HOST: 'config:email:smtpHost',
  SMTP_PORT: 'config:email:smtpPort',
  SMTP_USER: 'config:email:smtpUser',
  SMTP_FROM: 'config:email:from',
  SMTP_FROM_NAME: 'config:email:fromName',

  WORKER_CONCURRENCY: 'config:worker:concurrency',
  // Max CLI/agent invocations that run in parallel: bounds the cli-exec queue
  // concurrency AND the in-process fan-out limiter (e.g. DAG coders, onboarding
  // fan-outs). User-tunable per host capacity (>= 1; no upper limit — some
  // machines handle 10+).
  MAX_PARALLEL_AGENTS: 'config:worker:maxParallelAgents',
  // Minimum CLI-invocation timeout (ms) for Ollama providers. A CLI invocation
  // wraps a whole multi-turn agentic session, and local inference on weak
  // hardware can take many minutes per turn; this floors the per-step timeout so
  // a slow session isn't killed mid-generation. Default 2 h; raise for very
  // slow setups.
  OLLAMA_CLI_TIMEOUT_MS: 'config:worker:ollamaCliTimeoutMs',
  // When 'true', local in-stack Ollama models are allowed to run steps flagged
  // unsafeForLocalModels (skill generation, code simplification). Default false:
  // those steps fail for local models with an actionable message.
  ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS: 'config:worker:allowLocalModelDestructiveSteps',

  HOST_REPO_ROOT: 'config:filesystem:hostRepoRoot',
  REPO_STORAGE_PATH: 'config:filesystem:repoStoragePath',

  CLAWKER_BIN: 'config:sandbox:clawkerBin',
  SANDBOX_NETWORK: 'config:sandbox:network',
  // Global kill-switch for secret-file masking (hides deny-listed files from AI
  // CLI agents in the cli-exec sandbox). Default true; set 'false' to disable
  // masking for every repo without per-repo edits or a redeploy.
  SECRET_MASK_ENABLED: 'config:sandbox:secretMaskEnabled',

  APP_URL: 'config:app:url',

  ENCRYPTION_KEY: 'bootstrap:encryptionKey',

  MAINTENANCE_MODE: 'config:deployment:maintenanceMode',
  MAINTENANCE_MESSAGE: 'config:deployment:maintenanceMessage',

  // Global cross-task KB (separate DB; see plan luminous-weaving-archive.md §4).
  // Non-secret settings only; the external connection string is a SecretsService
  // secret (SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING), never plaintext config.
  GLOBAL_KB_ENABLED: 'config:globalKb:enabled',
  GLOBAL_KB_MODE: 'config:globalKb:mode',
  GLOBAL_KB_NAMESPACE: 'config:globalKb:namespace',
  GLOBAL_KB_OLLAMA_URL: 'config:globalKb:ollamaUrl',
  GLOBAL_KB_EMBED_MODEL: 'config:globalKb:embedModel',
  GLOBAL_KB_EMBED_DIMS: 'config:globalKb:embedDims',
  GLOBAL_KB_ARCHIVE_RETENTION_DAYS: 'config:globalKb:archiveRetentionDays',
} as const;

const DEFAULT_CONFIG: Record<string, string> = {
  [CONFIG_KEYS.API_PORT]: '3001',
  [CONFIG_KEYS.JWT_ACCESS_TTL]: '15m',
  [CONFIG_KEYS.JWT_REFRESH_TTL]: '7d',
  [CONFIG_KEYS.RATE_LIMIT_API_RPM]: '60',
  [CONFIG_KEYS.RATE_LIMIT_AUTH_RPM]: '10',
  [CONFIG_KEYS.SMTP_HOST]: 'mailpit',
  [CONFIG_KEYS.SMTP_PORT]: '1025',
  [CONFIG_KEYS.SMTP_FROM]: 'no-reply@haive.local',
  [CONFIG_KEYS.SMTP_FROM_NAME]: 'Haive',
  [CONFIG_KEYS.WORKER_CONCURRENCY]: '5',
  [CONFIG_KEYS.MAX_PARALLEL_AGENTS]: '3',
  [CONFIG_KEYS.OLLAMA_CLI_TIMEOUT_MS]: '7200000',
  [CONFIG_KEYS.ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS]: 'false',
  [CONFIG_KEYS.HOST_REPO_ROOT]: '/host-fs',
  [CONFIG_KEYS.REPO_STORAGE_PATH]: '/var/lib/haive/repos',
  [CONFIG_KEYS.CLAWKER_BIN]: '/usr/local/bin/clawker',
  [CONFIG_KEYS.SANDBOX_NETWORK]: 'haive-network',
  [CONFIG_KEYS.SECRET_MASK_ENABLED]: 'true',
  [CONFIG_KEYS.APP_URL]: 'http://localhost:3000',
  [CONFIG_KEYS.MAINTENANCE_MODE]: 'false',
  [CONFIG_KEYS.MAINTENANCE_MESSAGE]: 'Maintenance in progress. Please check back shortly.',
  // Global KB defaults: feature ON (no backward-compat concern; kept as a
  // kill-switch), Haive-hosted internal DB, single shared corpus, per-repo
  // default embedding dims. Ollama URL / model stay unset (null) until
  // configured → query falls back to deterministic hash embedding.
  [CONFIG_KEYS.GLOBAL_KB_ENABLED]: 'true',
  [CONFIG_KEYS.GLOBAL_KB_MODE]: 'internal',
  [CONFIG_KEYS.GLOBAL_KB_NAMESPACE]: 'default',
  [CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS]: '2560',
};

export class ConfigService {
  private redis: Redis | null = null;
  private initialized = false;
  private localCache = new Map<string, { value: string | null; expiresAt: number }>();
  private static LOCAL_CACHE_TTL_MS = 30_000;

  async initialize(redisUrl?: string): Promise<void> {
    if (this.initialized) return;

    const url = redisUrl ?? process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL environment variable is required');
    }

    this.redis = createRedisConnection(url);

    await new Promise<void>((resolve, reject) => {
      this.redis!.once('ready', resolve);
      this.redis!.once('error', reject);
    });

    await this.seedDefaults();
    await this.ensureEncryptionKey();

    this.initialized = true;
    logger.info('ConfigService initialized');
  }

  private async seedDefaults(): Promise<void> {
    const pipeline = this.redis!.pipeline();
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      pipeline.setnx(key, value);
    }
    const results = await pipeline.exec();
    if (results?.some(([, result]) => result === 1)) {
      logger.info('Default configuration seeded');
    }
  }

  private async ensureEncryptionKey(): Promise<void> {
    const exists = await this.redis!.exists(CONFIG_KEYS.ENCRYPTION_KEY);
    const envKey = this.getEnvEncryptionKey();

    if (!exists) {
      if (envKey) {
        await this.redis!.set(CONFIG_KEYS.ENCRYPTION_KEY, envKey);
        logger.info('Seeded encryption key from CONFIG_ENCRYPTION_KEY');
        return;
      }
      const generated = randomBytes(32).toString('hex');
      await this.redis!.set(CONFIG_KEYS.ENCRYPTION_KEY, generated);
      logger.warn('Generated new encryption key (CONFIG_ENCRYPTION_KEY not set)');
      return;
    }

    if (envKey) {
      const stored = await this.redis!.get(CONFIG_KEYS.ENCRYPTION_KEY);
      if (stored && stored !== envKey) {
        if (process.env.NODE_ENV === 'production') {
          throw new Error(
            'CONFIG_ENCRYPTION_KEY does not match the key stored in Redis. Aborting to prevent data corruption.',
          );
        }
        logger.warn('CONFIG_ENCRYPTION_KEY does not match Redis encryption key');
      }
    }
  }

  async get(key: string): Promise<string | null> {
    this.ensureInitialized();
    const cached = this.localCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    const value = await this.redis!.get(key);
    this.localCache.set(key, {
      value,
      expiresAt: Date.now() + ConfigService.LOCAL_CACHE_TTL_MS,
    });
    return value;
  }

  async getNumber(key: string, defaultValue = 0): Promise<number> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }

  async getBoolean(key: string, defaultValue = false): Promise<boolean> {
    const value = await this.get(key);
    if (value === null) return defaultValue;
    return value === 'true' || value === '1';
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureInitialized();
    await this.redis!.set(key, value);
    this.localCache.delete(key);
  }

  clearCache(): void {
    this.localCache.clear();
  }

  async getEncryptionKey(): Promise<string> {
    const key = await this.get(CONFIG_KEYS.ENCRYPTION_KEY);
    if (!key) {
      const envKey = this.getEnvEncryptionKey();
      if (envKey) {
        await this.redis!.set(CONFIG_KEYS.ENCRYPTION_KEY, envKey);
        return envKey;
      }
      throw new Error('Encryption key not found');
    }
    return key;
  }

  getRedis(): Redis {
    this.ensureInitialized();
    return this.redis!;
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.initialized = false;
    }
  }

  private getEnvEncryptionKey(): string | null {
    const raw = process.env.CONFIG_ENCRYPTION_KEY?.trim();
    if (!raw) return null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return raw.toLowerCase();
    }
    try {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) {
        return decoded.toString('hex');
      }
    } catch {
      // Ignore invalid base64
    }
    logger.warn('CONFIG_ENCRYPTION_KEY must be 64 hex chars or base64-encoded 32 bytes');
    return null;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('ConfigService not initialized. Call initialize() first.');
    }
  }
}

export const configService = new ConfigService();
