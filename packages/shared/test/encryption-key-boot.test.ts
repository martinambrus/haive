import { EventEmitter } from 'node:events';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/utils/redis-factory.js', () => ({ createRedisConnection: h.create }));
vi.mock('../src/logger/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { CONFIG_KEYS, ConfigService } from '../src/config/config.service.js';
import { logger } from '../src/logger/index.js';

const PENDING = 'bootstrap:pendingEncryptionKey';
const SOURCES = [
  'system_secrets',
  'users',
  'user_secrets',
  'cli_provider_secrets',
  'repo_credentials',
  'integration_provider_configs',
  'integration_connections',
];

class RedisFake extends EventEmitter {
  store = new Map<string, string>();
  disconnect = vi.fn();
  failPublish = false;
  beforeReserve: (() => void) | null = null;
  async quit() {}
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async exists(key: string) {
    return Number(this.store.has(key));
  }
  async set(key: string, value: string, mode?: string) {
    if (mode === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    return Number(this.store.delete(key));
  }
  async eval(script: string, _n: number, key: string, pending: string, expected: string) {
    if (script.includes("'NX'")) {
      this.beforeReserve?.();
      if (!this.store.has(key)) await this.set(pending, expected, 'NX');
      return null;
    }
    if (this.failPublish) throw new Error('publish failed');
    const published = !this.store.has(key);
    if (published) {
      if (this.store.get(pending) !== expected) throw new Error('pending key changed');
      this.store.set(key, JSON.parse(expected).key);
    }
    if (this.store.get(pending) === expected) this.store.delete(pending);
    return Number(published);
  }
  pipeline() {
    return { setnx: vi.fn(), exec: async () => [] };
  }
}

function database(counts: Record<string, number> = {}) {
  const audit = new Map<string, Record<string, unknown>>();
  const state = { counts: { ...counts }, failAudit: false };
  const execute = vi.fn(async (_query: SQL) =>
    SOURCES.map((source) => ({ source, count: String(state.counts[source] ?? 0) })),
  );
  const remove = vi.fn(async () => {
    state.counts.system_secrets = 0;
  });
  const insert = vi.fn(() => ({
    values: (row: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          if (state.failAudit) throw new Error('audit refused');
          const id = row.id as string;
          if (audit.has(id)) return [];
          audit.set(id, row);
          return [{ id }];
        },
      }),
    }),
  }));
  const db = {
    execute,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute, insert, delete: remove }),
    ),
  };
  return { db: db as unknown as Database, audit, state, execute, remove };
}

function boot(service: ConfigService, db?: Database | (() => Database)) {
  return service.initialize('redis://unit.invalid', db);
}

let redis: RedisFake;
const services: ConfigService[] = [];
function service() {
  const svc = new ConfigService();
  services.push(svc);
  return svc;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
  vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
  redis = new RedisFake();
  h.create.mockImplementation(() => {
    queueMicrotask(() => redis.emit('ready'));
    return redis;
  });
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((svc) => svc.close()));
  vi.unstubAllEnvs();
});

describe('boot encryption key safety', () => {
  it.each(SOURCES)('refuses a missing key with ciphertext in %s', async (source) => {
    const fixture = database({ [source]: 1 });
    await expect(boot(service(), fixture.db)).rejects.toThrow(
      /CONFIG_ENCRYPTION_KEY.*HAIVE_DISCARD_UNREADABLE_SECRETS=1/,
    );
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
    expect(redis.store.has(PENDING)).toBe(false);
    expect(fixture.audit.size).toBe(0);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it('identifies an invalid environment key instead of reporting it unset', async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'replace-with-your-key');
    await expect(boot(service(), database({ users: 1 }).db)).rejects.toThrow(
      /CONFIG_ENCRYPTION_KEY is set but invalid \(ignored\)/,
    );
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
  });

  it('reports corrupt pending JSON with the key recovery guidance', async () => {
    redis.store.set(PENDING, '{broken');
    await expect(boot(service(), database().db)).rejects.toThrow(
      'Invalid pending encryption key; restore the original CONFIG_ENCRYPTION_KEY',
    );
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
  });

  it('requires a database rather than assuming this is a fresh install', async () => {
    await expect(boot(service())).rejects.toThrow(/database/i);
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
  });

  it('does not generate if the ciphertext inventory fails', async () => {
    const fixture = database();
    fixture.execute.mockRejectedValueOnce(new Error('inventory unavailable'));
    await expect(boot(service(), fixture.db)).rejects.toThrow('inventory unavailable');
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
  });

  it('generates on an empty first install', async () => {
    const fixture = database();
    const svc = service();
    await boot(svc, fixture.db);
    expect(await svc.getEncryptionKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.audit.size).toBe(0);
    const query = new PgDialect().sqlToQuery(fixture.execute.mock.calls[0]![0]);
    for (const source of SOURCES) expect(query.sql).toContain(`"${source}"`);
    expect(query.sql).toContain('is not null');
  });

  it('adopts a key published while the database inventory was being read', async () => {
    const fixture = database({ system_secrets: 3 });
    const key = 'ef'.repeat(32);
    fixture.execute.mockImplementationOnce(async () => {
      redis.store.set(CONFIG_KEYS.ENCRYPTION_KEY, key);
      return [{ source: 'system_secrets', count: '3' }];
    });
    const svc = service();
    await boot(svc, fixture.db);
    expect(await svc.getEncryptionKey()).toBe(key);
    expect(fixture.audit.size).toBe(0);
  });

  it('creates a lazy inventory connection only when generating a key', async () => {
    const getDb = vi.fn(() => database().db);
    await boot(service(), getDb);
    expect(getDb).toHaveBeenCalledTimes(1);
    await boot(service(), getDb);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it('preserves the environment-key path without querying the database', async () => {
    const key = 'ab'.repeat(32);
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', key);
    const fixture = database({ system_secrets: 4 });
    const svc = service();
    await boot(svc, fixture.db);
    expect(await svc.getEncryptionKey()).toBe(key);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.audit.size).toBe(0);
  });

  it('preserves a Redis key without querying the database or using the override', async () => {
    const key = 'cd'.repeat(32);
    redis.store.set(CONFIG_KEYS.ENCRYPTION_KEY, key);
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = database({ system_secrets: 4 });
    const svc = service();
    await boot(svc, fixture.db);
    expect(await svc.getEncryptionKey()).toBe(key);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.audit.size).toBe(0);
  });

  it('concurrent fresh boots use one key', async () => {
    const fixture = database();
    const a = service();
    const b = service();
    await Promise.all([boot(a, fixture.db), boot(b, fixture.db)]);
    expect(await a.getEncryptionKey()).toBe(await b.getEncryptionKey());
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.filter(
          ([message]) =>
            typeof message === 'string' && message.startsWith('Generated new encryption key'),
        ),
    ).toHaveLength(1);
  });

  it('does not reserve or audit after a peer publishes just before reservation', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = database({ system_secrets: 3 });
    const key = 'ef'.repeat(32);
    redis.beforeReserve = () => redis.store.set(CONFIG_KEYS.ENCRYPTION_KEY, key);
    const svc = service();
    await boot(svc, fixture.db);
    expect(await svc.getEncryptionKey()).toBe(key);
    expect(redis.store.has(PENDING)).toBe(false);
    expect(fixture.audit.size).toBe(0);
  });

  it('an explicit discard generates, warns with the count, and audits once across boots', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = database({ system_secrets: 3, users: 2, user_secrets: 1 });
    const a = service();
    const b = service();
    await Promise.all([boot(a, fixture.db), boot(b, fixture.db)]);
    await boot(service(), fixture.db);
    expect(await a.getEncryptionKey()).toBe(await b.getEncryptionKey());
    expect(fixture.audit.size).toBe(1);
    expect([...fixture.audit.values()][0]).toMatchObject({
      actorUserId: '00000000-0000-0000-0000-000000000000',
      action: 'config.discard_unreadable_secrets',
      targetType: 'system',
      metadata: { unreadableSecretCount: 6, discardedSystemSecretCount: 3 },
    });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    expect(fixture.state.counts.user_secrets).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unreadableSecretCount: 6 }),
      expect.stringContaining('Discarding unreadable secrets'),
    );
    expect(redis.store.has(PENDING)).toBe(false);
  });

  it('accepts only the exact discard value 1', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', 'true');
    await expect(boot(service(), database({ users: 1 }).db)).rejects.toThrow(
      'HAIVE_DISCARD_UNREADABLE_SECRETS=1',
    );
  });

  it('does not publish or discard anything when the required audit fails', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = database({ system_secrets: 3 });
    fixture.state.failAudit = true;
    await expect(boot(service(), fixture.db)).rejects.toThrow('audit refused');
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it('reuses the committed audit and pending key after a publication failure', async () => {
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = database({ system_secrets: 3 });
    redis.failPublish = true;
    await expect(boot(service(), fixture.db)).rejects.toThrow('Configuration store unavailable');
    expect(fixture.audit.size).toBe(1);
    const pending = JSON.parse(redis.store.get(PENDING)!);
    redis.failPublish = false;
    const retry = service();
    await boot(retry, fixture.db);
    expect(await retry.getEncryptionKey()).toBe(pending.key);
    expect(fixture.audit.size).toBe(1);
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });
});
