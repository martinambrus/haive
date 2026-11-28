import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Sql } from 'postgres';
import {
  encryptionKeyBootDatabase,
  PENDING_ENCRYPTION_KEY_WAIT_MS,
} from '../src/config/encryption-key-boot.js';
import { sql, type SQL } from 'drizzle-orm';
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
import { ConfigUnavailableError } from '../src/config/config-unavailable.js';
import { SecretUnreadableError } from '../src/config/secret-unreadable.js';
import { encrypt, tryDecrypt } from '../src/crypto/index.js';

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
  /** Runs right after a read found the key absent: another process may seed before the caller acts. */
  afterEmptyRead: (() => void) | null = null;
  async quit() {}
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async exists(key: string) {
    const present = this.store.has(key);
    if (!present) this.afterEmptyRead?.();
    return Number(present);
  }
  async set(key: string, value: string, mode?: string) {
    if (mode === 'NX' && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async del(key: string) {
    return Number(this.store.delete(key));
  }
  async eval(
    script: string,
    _n: number,
    key: string,
    pending: string,
    expected: string,
    now?: number,
    waitMs?: number,
  ) {
    if (script.includes('-- Seed environment key')) {
      if (this.store.has(key)) return 0;
      if (this.store.has(pending)) {
        if (now === undefined || waitMs === undefined) return -1;
        // Model return codes only; the gated Redis file exercises the actual Lua.
        try {
          const { reservedAt } = JSON.parse(this.store.get(pending)!);
          return typeof reservedAt === 'number' &&
            reservedAt >= 0 &&
            reservedAt <= now &&
            now - reservedAt < waitMs
            ? -1
            : -2;
        } catch {
          return -2;
        }
      }
      this.store.set(key, expected);
      return 1;
    }
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

interface StoredSecret {
  key: string;
  encrypted_value: string;
}

function database(counts: Record<string, number> = {}, systemSecrets: StoredSecret[] = []) {
  const audit = new Map<string, Record<string, unknown>>();
  const state = {
    counts: { ...counts },
    failAudit: false,
    systemSecrets: [...systemSecrets],
    onAudit: null as (() => void) | null,
  };
  const execute = vi.fn(async (query: SQL) => {
    const text = new PgDialect().sqlToQuery(query).sql;
    if (text.includes('to_regclass')) return [{ providers: true, connections: true }];
    if (text.toLowerCase().includes('lock table')) return [];
    // The probe that reads the stored system secrets so the boot can test the key against them.
    if (text.includes('system_secrets') && text.includes('encrypted_value'))
      return [...state.systemSecrets];
    return SOURCES.map((source) => ({ source, count: String(state.counts[source] ?? 0) }));
  });
  const remove = vi.fn(async () => {
    state.counts.system_secrets = 0;
    state.systemSecrets = [];
  });
  const insert = vi.fn(() => ({
    values: (row: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: async () => {
          state.onAudit?.();
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

function boot(service: ConfigService, db?: Parameters<ConfigService['initialize']>[1]) {
  return service.initialize('redis://unit.invalid', db);
}

const randomKey = () => randomBytes(32).toString('hex');
/** Rows in the shape the boot probe reads, each encrypted under the given key. */
function storedRows(key: string, count = 3): StoredSecret[] {
  return ['master_kek', 'jwt_secret', 'email_blind_index_pepper', 'global_kb_connection_string']
    .slice(0, count)
    .map((name) => ({ key: name, encrypted_value: encrypt(randomBytes(16).toString('hex'), key) }));
}
/** A rejection settled to its error, so a resolved boot never leaks a value into a message. */
async function settleBoot(promise: Promise<unknown>) {
  return promise.then(
    () => ({ kind: 'resolved' as const }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
}

let redis: RedisFake;
const services: ConfigService[] = [];
function service(waitMs?: number) {
  const svc = waitMs === undefined ? new ConfigService() : new ConfigService(waitMs);
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
  vi.restoreAllMocks();
});

describe('boot encryption key safety', () => {
  it('still inventories ciphertext when the catalog returns no capability row', async () => {
    const { db, execute } = database({ system_secrets: 1 });
    execute.mockResolvedValueOnce([]);
    await expect(boot(service(), db)).rejects.toThrow('1 encrypted rows exist');
    const inventory = new PgDialect().sqlToQuery(execute.mock.calls[1]![0]).sql;
    expect(inventory).toContain('integration_provider_configs');
    expect(inventory).toContain('integration_connections');
    expect(execute).toHaveBeenCalledTimes(2);
  });

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
    const query = new PgDialect().sqlToQuery(fixture.execute.mock.calls[1]![0]);
    for (const source of SOURCES) expect(query.sql).toContain(`"${source}"`);
    expect(query.sql).toContain('is not null');
  });

  it.each([0, 1])(
    'boots through an existing postgres client only when its ciphertext inventory is empty: %i',
    async (count) => {
      const client = {
        options: { parsers: {}, serializers: {} },
        unsafe: vi.fn(async (query: string, _params: unknown[]) =>
          query.includes('to_regclass')
            ? [{ providers: true, connections: true }]
            : [{ source: 'system_secrets', count: String(count) }],
        ),
        begin: vi.fn(),
      };
      const source = encryptionKeyBootDatabase(client as unknown as Sql);
      const svc = service();
      if (count) await expect(boot(svc, () => source)).rejects.toThrow('Refusing to generate');
      else {
        await boot(svc, () => source);
        expect(await svc.getEncryptionKey()).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(client.unsafe).toHaveBeenCalledTimes(2);
      for (const table of SOURCES) expect(client.unsafe.mock.calls[1]![0]).toContain(`"${table}"`);
      expect(client.begin).not.toHaveBeenCalled();
    },
  );

  it('adopts a key published while the database inventory was being read', async () => {
    const fixture = database({ system_secrets: 3 });
    const key = 'ef'.repeat(32);
    fixture.execute.mockResolvedValueOnce([{ providers: true, connections: true }]);
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

  it('checks an environment key against the stored system secrets with one probe and no inventory', async () => {
    const key = randomKey();
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', key);
    const fixture = database({ system_secrets: 4 }, storedRows(key, 4));
    const svc = service();
    await boot(svc, fixture.db);
    expect(await svc.getEncryptionKey()).toBe(key);
    const statements = fixture.execute.mock.calls.map(
      ([query]) => new PgDialect().sqlToQuery(query).sql,
    );
    expect(
      statements.filter(
        (text) => text.includes('system_secrets') && text.includes('encrypted_value'),
      ),
    ).toHaveLength(1);
    expect(statements.some((text) => text.toLowerCase().includes('union all'))).toBe(false);
    expect(fixture.audit.size).toBe(0);
  });

  it('holds a restored environment key while a reserved discard is pending, then checks the winner', async () => {
    const key = 'ab'.repeat(32);
    const candidate = JSON.stringify({
      id: '00000000-0000-0000-0000-000000000001',
      key: 'cd'.repeat(32),
      discard: true,
      reservedAt: Date.now(),
    });
    redis.store.set(PENDING, candidate);
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', key);
    vi.stubEnv('NODE_ENV', 'production');
    const svc = service();
    await expect(boot(svc)).rejects.toBeInstanceOf(ConfigUnavailableError);
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
    expect(redis.store.get(PENDING)).toBe(candidate);
    // The discarder commits and publishes before the env-key boot retries.
    redis.store.set(CONFIG_KEYS.ENCRYPTION_KEY, JSON.parse(candidate).key);
    redis.store.delete(PENDING);
    await expect(boot(svc)).rejects.toThrow('does not match');
  });

  it('holds fallback environment-key recovery behind a pending discard too', async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'ab'.repeat(32));
    const svc = service();
    await boot(svc);
    redis.store.delete(CONFIG_KEYS.ENCRYPTION_KEY);
    redis.store.set(
      PENDING,
      JSON.stringify({ discard: true, key: 'cd'.repeat(32), reservedAt: Date.now() }),
    );
    svc.clearCache();
    await expect(svc.getEncryptionKey()).rejects.toBeInstanceOf(ConfigUnavailableError);
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
  });

  it('pins the production pending wait to ten minutes', () => {
    expect(PENDING_ENCRYPTION_KEY_WAIT_MS).toBe(10 * 60 * 1000);
  });

  it.each(['boot', 'fallback'])('reports a young discard as retryable during %s', async (path) => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'ab'.repeat(32));
    const svc = service(10);
    if (path === 'fallback') await boot(svc);
    redis.store.delete(CONFIG_KEYS.ENCRYPTION_KEY);
    const pending = JSON.stringify({ reservedAt: 991, discard: true });
    redis.store.set(PENDING, pending);
    svc.clearCache();
    const error = await (path === 'boot' ? boot(svc) : svc.getEncryptionKey()).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigUnavailableError);
    expect(error.cause.message).toContain('secret discard is in progress');
    expect(redis.store.get(PENDING)).toBe(pending);
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
  });

  it.each([
    ['at the bound', { reservedAt: 990 }],
    ['past the bound', { reservedAt: 989 }],
    ['legacy pending', {}],
    ['unreadable timestamp', { reservedAt: '991' }],
    ['corrupt JSON', null],
  ])('fails loudly for %s on boot and fallback', async (_label, value) => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'ab'.repeat(32));
    const pending = value ? JSON.stringify(value) : '{broken';
    for (const path of ['boot', 'fallback']) {
      const svc = service(10);
      redis.store.delete(PENDING);
      if (path === 'fallback') await boot(svc);
      redis.store.delete(CONFIG_KEYS.ENCRYPTION_KEY);
      redis.store.set(PENDING, pending);
      svc.clearCache();
      const error = await (path === 'boot' ? boot(svc) : svc.getEncryptionKey()).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ConfigUnavailableError);
      expect(error.message).toContain(PENDING);
      expect(error.message).toContain('interrupted secret discard');
      expect(error.message).toContain('without CONFIG_ENCRYPTION_KEY');
      expect(error.message).toContain('HAIVE_DISCARD_UNREADABLE_SECRETS=1');
      expect(error.message).toContain('audit_events');
      expect(error.message).toContain('config.discard_unreadable_secrets');
      expect(error.message).toContain('id');
      expect(error.message).toContain('did not commit');
      expect(error.message).toContain('delete');
      expect(redis.store.get(PENDING)).toBe(pending);
      expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
    }
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
    expect(pending.reservedAt).toEqual(expect.any(Number));
    redis.failPublish = false;
    const retry = service();
    await boot(retry, fixture.db);
    expect(await retry.getEncryptionKey()).toBe(pending.key);
    expect(fixture.audit.size).toBe(1);
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });
});

describe('an environment key that cannot read the stored system secrets', () => {
  const NAMES = ['master_kek', 'jwt_secret', 'email_blind_index_pepper'];

  function expectB1(
    outcome: Awaited<ReturnType<typeof settleBoot>>,
    fixture: ReturnType<typeof database>,
  ) {
    expect(outcome.kind).toBe('rejected');
    const error = (outcome as { error: SecretUnreadableError }).error;
    expect(error).toBeInstanceOf(SecretUnreadableError);
    expect([...error.secretKeys].sort()).toEqual([...NAMES].sort());
    expect(error.message).toContain('CONFIG_ENCRYPTION_KEY');
    expect(error.message).toContain('HAIVE_DISCARD_UNREADABLE_SECRETS=1');
    // Redis is empty on this path, so there is no stored key to tell the operator to remove.
    expect(error.message).not.toContain(CONFIG_KEYS.ENCRYPTION_KEY);
    expect(redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
    expect(redis.store.has(PENDING)).toBe(false);
    expect(fixture.audit.size).toBe(0);
    expect(fixture.remove).not.toHaveBeenCalled();
  }

  it.each(['development', 'production'])('B1 refuses to seed it under NODE_ENV=%s', async (env) => {
    vi.stubEnv('NODE_ENV', env);
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', randomKey());
    const fixture = database({ system_secrets: 3 }, storedRows(randomKey()));
    expectB1(await settleBoot(boot(service(), fixture.db)), fixture);
  });

  it('B1 self-check: the same assertions hold for a hand-built correct double', async () => {
    const key = randomKey();
    const fixture = database({ system_secrets: 3 }, storedRows(randomKey()));
    const correctBoot = async () => {
      const rows = (await fixture.db.execute(
        sql`select key, encrypted_value from system_secrets`,
      )) as unknown as StoredSecret[];
      const unreadable = rows.filter((row) => tryDecrypt(row.encrypted_value, key) === null);
      if (unreadable.length > 0)
        throw new SecretUnreadableError(
          'CONFIG_ENCRYPTION_KEY cannot read the stored secrets; set HAIVE_DISCARD_UNREADABLE_SECRETS=1 to discard them',
          unreadable.map((row) => row.key),
        );
    };
    expectB1(await settleBoot(correctBoot()), fixture);
  });

  it.each([
    ['rows it can read', true],
    ['no rows', false],
  ])('B2 boots and holds the key with %s', async (_label, withRows) => {
    const key = randomKey();
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', key);
    const fixture = database({ system_secrets: withRows ? 3 : 0 }, withRows ? storedRows(key) : []);
    const svc = service();
    await boot(svc, fixture.db);
    expect(redis.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(key);
    expect(await svc.getEncryptionKey()).toBe(key);
    expect(fixture.audit.size).toBe(0);
  });

  it('B3 with the override settles the key first, then audits and discards', async () => {
    const key = randomKey();
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', key);
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
    const fixture = database({ system_secrets: 3 }, storedRows(randomKey()));
    let seededAtAudit: boolean | null = null;
    fixture.state.onAudit = () => {
      seededAtAudit = redis.store.has(CONFIG_KEYS.ENCRYPTION_KEY);
    };
    const svc = service();
    await boot(svc, fixture.db);
    expect(fixture.audit.size).toBe(1);
    expect([...fixture.audit.values()][0]).toMatchObject({
      actorUserId: '00000000-0000-0000-0000-000000000000',
      action: 'config.discard_unreadable_secrets',
      targetType: 'system',
      metadata: { discardedSystemSecretCount: 3, keyPresent: true },
    });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    // A discard rewrites the install, so this key is the install's before the first write.
    expect(seededAtAudit).toBe(true);
    expect(redis.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(key);
    expect(await svc.getEncryptionKey()).toBe(key);
  });

  it.each(['production', 'development'])(
    'B7 with the override, a key that lost the Redis race discards nothing under NODE_ENV=%s',
    async (env) => {
      const original = randomKey();
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('CONFIG_ENCRYPTION_KEY', randomKey());
      vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '1');
      const fixture = database({ system_secrets: 3 }, storedRows(original));
      // The process holding the original key seeds Redis right after this one read it empty.
      redis.afterEmptyRead = () => redis.store.set(CONFIG_KEYS.ENCRYPTION_KEY, original);
      const outcome = await settleBoot(boot(service(), fixture.db));
      if (env === 'production') {
        expect(outcome.kind).toBe('rejected');
        expect((outcome as { error: Error }).error.message).toContain('does not match');
      } else {
        expect(outcome.kind).toBe('resolved');
      }
      expect(redis.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(original);
      expect(fixture.audit.size).toBe(0);
      expect(fixture.remove).not.toHaveBeenCalled();
      expect(fixture.state.systemSecrets).toHaveLength(3);
    },
  );

  it('B4 seeds the key without a database argument and without a query', async () => {
    const key = randomKey();
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', key);
    const svc = service();
    await boot(svc);
    expect(redis.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(key);
    expect(await svc.getEncryptionKey()).toBe(key);
  });

  it('B5 calls the database factory once when Redis is empty and an environment key is set', async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', randomKey());
    const getDb = vi.fn(() => database().db);
    await boot(service(), getDb);
    expect(getDb).toHaveBeenCalledTimes(1);
  });

  it('B5 never calls the database factory when Redis already holds a key', async () => {
    redis.store.set(CONFIG_KEYS.ENCRYPTION_KEY, randomKey());
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', randomKey());
    const getDb = vi.fn(() => database().db);
    await boot(service(), getDb);
    expect(getDb).not.toHaveBeenCalled();
  });
});
