import { EventEmitter } from 'node:events';
import type { Database } from '@haive/database';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/utils/redis-factory.js', () => ({ createRedisConnection: h.create }));
vi.mock('../src/logger/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CONFIG_KEYS, ConfigService, configService } from '../src/config/config.service.js';
import { ConfigUnavailableError } from '../src/config/config-unavailable.js';
import { SECRET_KEYS, SecretsService } from '../src/config/secrets.service.js';
import { logger } from '../src/logger/index.js';

const RETIRED = [
  'config:email:smtpHost',
  'config:email:smtpPort',
  'config:email:from',
  'config:email:fromName',
];
const ENC_KEY = 'ab'.repeat(32);

class FakeRedis extends EventEmitter {
  store = new Map<string, string>([[CONFIG_KEYS.ENCRYPTION_KEY, ENC_KEY]]);
  removed: string[] = [];
  failDelete = false;
  disconnect = vi.fn();
  async quit() {}
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async exists(key: string) {
    return this.store.has(key) ? 1 : 0;
  }
  async set(key: string, value: string) {
    this.store.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    if (this.failDelete) throw new Error('store unavailable');
    if (!this.store.delete(key)) return 0;
    this.removed.push(key);
    return 1;
  }
  pipeline() {
    const pending: Array<[string, string]> = [];
    return {
      setnx: (key: string, value: string) => pending.push([key, value]),
      exec: async () =>
        pending.map(([key, value]) => {
          if (this.store.has(key)) return [null, 0];
          this.store.set(key, value);
          return [null, 1];
        }),
    };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', ENC_KEY);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('retired Redis configuration on boot', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    h.create.mockImplementation(() => {
      queueMicrotask(() => redis.emit('ready'));
      return redis;
    });
  });

  async function boot() {
    const service = new ConfigService();
    await service.initialize('redis://fake');
    await service.close();
  }

  it('removes the four old defaults, including customized values, and logs only removed keys', async () => {
    for (const key of RETIRED) redis.store.set(key, 'custom value');
    redis.store.set(CONFIG_KEYS.API_PORT, '4321');
    await boot();
    expect(RETIRED.filter((key) => redis.store.has(key))).toEqual([]);
    expect(redis.removed).toEqual(RETIRED);
    expect(redis.store.get(CONFIG_KEYS.API_PORT)).toBe('4321');
    for (const key of RETIRED) {
      expect(logger.info).toHaveBeenCalledWith({ key }, expect.any(String));
    }
  });

  it('does not seed retired configuration on a fresh install', async () => {
    await boot();
    expect(RETIRED.filter((key) => redis.store.has(key))).toEqual([]);
    expect(Object.values(CONFIG_KEYS).filter((key) => key.startsWith('config:email:'))).toEqual([]);
  });

  it('leaves the store and removal logs unchanged on the next boot', async () => {
    for (const key of RETIRED) redis.store.set(key, 'old value');
    await boot();
    const stored = new Map(redis.store);
    const removed = [...redis.removed];
    vi.mocked(logger.info).mockClear();
    await boot();
    expect(redis.store).toEqual(stored);
    expect(redis.removed).toEqual(removed);
    expect(logger.info).not.toHaveBeenCalledWith({ key: expect.any(String) }, expect.any(String));
  });

  it('seeds disabled mail in production and preserves administrator choices', async () => {
    await boot();
    expect(redis.store.get('config:mail:enabled')).toBe('false');
    expect(redis.store.get('config:mail:smtpHost')).toBe('');
    redis.store.set('config:mail:smtpHost', 'chosen.internal');
    vi.stubEnv('HAIVE_MAIL_SMTP_HOST', 'mailpit');
    vi.stubEnv('HAIVE_MAIL_ENABLED', 'true');
    vi.stubEnv('HAIVE_MAIL_FROM', 'haive@example.test');
    await boot();
    expect(redis.store.get('config:mail:smtpHost')).toBe('chosen.internal');
    expect(redis.store.get('config:mail:enabled')).toBe('false');
  });

  it('seeds validated environment defaults on first boot for dev Mailpit', async () => {
    vi.stubEnv('HAIVE_MAIL_SMTP_HOST', 'mailpit');
    vi.stubEnv('HAIVE_MAIL_SMTP_PORT', '1025');
    vi.stubEnv('HAIVE_MAIL_ENABLED', 'true');
    vi.stubEnv('HAIVE_MAIL_SECURE', 'false');
    vi.stubEnv('HAIVE_MAIL_FROM', 'haive@example.test');
    await boot();
    expect(redis.store.get('config:mail:smtpHost')).toBe('mailpit');
    expect(redis.store.get('config:mail:smtpPort')).toBe('1025');
    expect(redis.store.get('config:mail:enabled')).toBe('true');
    expect(redis.store.get('config:mail:secure')).toBe('false');
    expect(redis.store.get('config:mail:from')).toBe('haive@example.test');
  });

  it('refuses an invalid environment seed', async () => {
    vi.stubEnv('HAIVE_MAIL_SMTP_PORT', 'not-a-port');
    await expect(boot()).rejects.toThrow();
    expect(redis.store.has('config:mail:enabled')).toBe(false);
  });

  it('fails boot with the typed outage and retries cleanup on the same instance', async () => {
    redis.store.set(RETIRED[0]!, 'old value');
    redis.failDelete = true;
    const service = new ConfigService();
    await expect(service.initialize('redis://fake')).rejects.toBeInstanceOf(ConfigUnavailableError);
    expect(redis.disconnect).toHaveBeenCalledOnce();
    redis.failDelete = false;
    await service.initialize('redis://fake');
    expect(redis.store.has(RETIRED[0]!)).toBe(false);
    await service.close();
  });
});

describe('retired system secrets on boot', () => {
  let rows: Map<string, { key: string; description: null; updatedAt: Date }>;
  let removed: string[];
  let db: Database;
  let failDelete: boolean;
  beforeEach(() => {
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(ENC_KEY);
    rows = new Map(
      ['smtp_password', SECRET_KEYS.JWT_SECRET].map((key) => [
        key,
        { key, description: null, updatedAt: new Date() },
      ]),
    );
    removed = [];
    failDelete = false;
    db = {
      delete: () => ({
        where: (where: SQL) => ({
          returning: async () => {
            if (failDelete) throw new Error('database unavailable');
            const query = new PgDialect().sqlToQuery(where);
            expect(query.sql).toBe('"system_secrets"."key" = $1');
            const key = query.params[0] as string;
            if (!rows.delete(key)) return [];
            removed.push(key);
            return [{ key }];
          },
        }),
      }),
      select: () => ({
        from: () => ({ orderBy: async () => [...rows.values()] }),
      }),
    } as unknown as Database;
  });

  it('deletes only the retired password and excludes it from the secret listing', async () => {
    const service = new SecretsService();
    await service.initialize(db);
    expect(removed).toEqual(['smtp_password']);
    expect(await service.listKeys()).toEqual([rows.get(SECRET_KEYS.JWT_SECRET)]);
    expect(Object.values(SECRET_KEYS)).not.toContain('smtp_password');
    expect(logger.info).toHaveBeenCalledWith({ key: 'smtp_password' }, expect.any(String));
  });

  it('preserves the new mail password while deleting the retired SMTP password', async () => {
    rows.set(SECRET_KEYS.MAIL_SMTP_PASSWORD, {
      key: SECRET_KEYS.MAIL_SMTP_PASSWORD,
      description: null,
      updatedAt: new Date(),
    });
    const service = new SecretsService();
    await service.initialize(db);
    expect(removed).toEqual(['smtp_password']);
    expect(await service.listKeys()).toContainEqual(rows.get(SECRET_KEYS.MAIL_SMTP_PASSWORD));
  });

  it('does not remove or log any secret on the next boot', async () => {
    await new SecretsService().initialize(db);
    const stored = new Map(rows);
    const firstRemoved = [...removed];
    vi.mocked(logger.info).mockClear();
    await new SecretsService().initialize(db);
    expect(rows).toEqual(stored);
    expect(removed).toEqual(firstRemoved);
    expect(logger.info).not.toHaveBeenCalledWith({ key: expect.any(String) }, expect.any(String));
  });

  it('fails boot when deletion fails and retries instead of marking the service initialized', async () => {
    failDelete = true;
    const service = new SecretsService();
    await expect(service.initialize(db)).rejects.toThrow('database unavailable');
    failDelete = false;
    await service.initialize(db);
    expect(removed).toEqual(['smtp_password']);
  });
});
