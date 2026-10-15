import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, ConfigService, configService } from '../src/config/config.service.js';
import { SECRET_KEYS, SecretsService, secretsService } from '../src/config/secrets.service.js';
import { encrypt, generateEncryptionKey } from '../src/crypto/index.js';
import { resolveGlobalKbConnection, resolveGlobalKbSettings } from '../src/global-kb/connection.js';

const CONNECTION_STRING = 'postgres://kb.example/old';
const CACHED_SETTINGS = [
  CONFIG_KEYS.GLOBAL_KB_ENABLED,
  CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED,
  CONFIG_KEYS.GLOBAL_KB_NAMESPACE,
  CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL,
  CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL,
  CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS,
  CONFIG_KEYS.GLOBAL_KB_ARCHIVE_RETENTION_DAYS,
];

// Two processes over one Redis and one secrets table: the singletons resolve, the others write.
const encryptionKey = generateEncryptionKey();
const redisValues = new Map<string, string>();
const redisReads = new Map<string, number>();
const redis = {
  get: async (name: string) => {
    redisReads.set(name, (redisReads.get(name) ?? 0) + 1);
    return redisValues.get(name) ?? null;
  },
  set: async (name: string, value: string) => {
    redisValues.set(name, value);
    return 'OK';
  },
};
let storedSecret: string | null = null;
let beforeSecretRead: (() => Promise<void>) | null = null;
const db = {
  query: {
    systemSecrets: {
      findFirst: async () => {
        await beforeSecretRead?.();
        return storedSecret === null ? undefined : { encryptedValue: storedSecret };
      },
    },
  },
  delete: () => ({
    where: async () => {
      storedSecret = null;
    },
  }),
} as unknown as Database;

const wire = (config: ConfigService): ConfigService => {
  Object.assign(config, { redis, initialized: true });
  return config;
};

const otherConfig = wire(new ConfigService());
const otherSecrets = new SecretsService();

beforeAll(async () => {
  redisValues.set(CONFIG_KEYS.ENCRYPTION_KEY, encryptionKey);
  wire(configService);
  await secretsService.initialize(db);
  await otherSecrets.initialize(db);
});

beforeEach(() => {
  configService.clearCache();
  otherConfig.clearCache();
  secretsService.clearCache();
  otherSecrets.clearCache();
  redisValues.set(CONFIG_KEYS.GLOBAL_KB_MODE, 'external');
  storedSecret = encrypt(CONNECTION_STRING, encryptionKey);
  beforeSecretRead = null;
  redisReads.clear();
});

describe('resolveGlobalKbSettings in a process whose caches are warm', () => {
  it('reports a store switch and a removed connection string from another process at once', async () => {
    expect(await resolveGlobalKbSettings()).toMatchObject({
      mode: 'external',
      connectionString: CONNECTION_STRING,
    });

    await otherConfig.set(CONFIG_KEYS.GLOBAL_KB_MODE, 'internal');
    await otherSecrets.delete(SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING);

    expect(await resolveGlobalKbSettings()).toMatchObject({
      mode: 'internal',
      connectionString: null,
    });
  });

  it('still serves every other setting from the 30 s cache', async () => {
    await resolveGlobalKbSettings();
    await resolveGlobalKbSettings();

    expect(CACHED_SETTINGS.map((name) => redisReads.get(name))).toEqual(
      CACHED_SETTINGS.map(() => 1),
    );
  });
});

describe('resolveGlobalKbSettings when the mode and the string are read either side of a clear', () => {
  const modeReads = () => redisReads.get(CONFIG_KEYS.GLOBAL_KB_MODE);

  it('resolves the built-in store when a switch and a removal land between the two reads', async () => {
    beforeSecretRead = async () => {
      await otherConfig.set(CONFIG_KEYS.GLOBAL_KB_MODE, 'internal');
      await otherSecrets.delete(SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING);
    };

    expect(await resolveGlobalKbSettings()).toMatchObject({
      mode: 'internal',
      connectionString: null,
    });
    expect(modeReads()).toBe(2);
  });

  it('keeps the missing-string error when the mode still reads external', async () => {
    storedSecret = null;

    const settings = await resolveGlobalKbSettings();

    expect(settings).toMatchObject({ mode: 'external', connectionString: null });
    await expect(resolveGlobalKbConnection(settings, db)).rejects.toThrow(
      'external globalKbMode requires the GLOBAL_KB_CONNECTION_STRING secret',
    );
    expect(modeReads()).toBe(2);
  });

  it('resolves the built-in store when a switch away stores a new string between the two reads', async () => {
    beforeSecretRead = async () => {
      await otherConfig.set(CONFIG_KEYS.GLOBAL_KB_MODE, 'internal');
      storedSecret = encrypt('postgres://kb.example/new', encryptionKey);
    };

    expect(await resolveGlobalKbSettings()).toMatchObject({ mode: 'internal' });
    expect(modeReads()).toBe(2);
  });

  it('keeps the external store and its string when the second read still says external', async () => {
    expect(await resolveGlobalKbSettings()).toMatchObject({
      mode: 'external',
      connectionString: CONNECTION_STRING,
    });
    expect(modeReads()).toBe(2);
  });

  it('reads the mode once for the built-in store', async () => {
    redisValues.set(CONFIG_KEYS.GLOBAL_KB_MODE, 'internal');
    storedSecret = null;

    await resolveGlobalKbSettings();

    expect(modeReads()).toBe(1);
  });
});
