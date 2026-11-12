import { Redis } from 'ioredis';
import type { Database } from '@haive/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS, ConfigService } from '../src/config/config.service.js';
import * as boot from '../src/config/encryption-key-boot.js';

vi.mock('../src/logger/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const url = process.env.ENCRYPTION_KEY_BOOT_REDIS_TEST_URL;
if (url && !/^redis:\/\/127\.0\.0\.1:\d+\/3$/.test(url)) {
  throw new Error('Use a dedicated loopback Redis database 3');
}
const key = CONFIG_KEYS.ENCRYPTION_KEY;
const pending = boot.PENDING_ENCRYPTION_KEY;
const first = JSON.stringify({
  id: '00000000-0000-0000-0000-000000000001',
  key: 'ab'.repeat(32),
  discard: false,
});
const second = JSON.stringify({
  id: '00000000-0000-0000-0000-000000000002',
  key: 'cd'.repeat(32),
  discard: false,
});

describe.skipIf(!url)('boot encryption key atomic Redis store', () => {
  let redis: Redis;
  let config: ConfigService;
  let store: Parameters<typeof boot.generateBootEncryptionKey>[1];

  beforeAll(async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
    redis = new Redis(url!);
    await redis.ping();
  });
  beforeEach(async () => {
    await redis.del(key, pending);
    config = new ConfigService();
    // Call through: capture the callbacks supplied by ConfigService, including its actual Lua.
    // Only the ciphertext inventory is faked; all Redis commands use the real connection.
    const generate = vi.spyOn(boot, 'generateBootEncryptionKey');
    try {
      await config.initialize(url!, { execute: async () => [] } as unknown as Database);
      store = generate.mock.calls[0]![1];
    } finally {
      generate.mockRestore();
    }
  });
  afterEach(async () => {
    await config?.close();
    await redis.del(key, pending);
  });
  afterAll(async () => {
    await redis?.quit();
    vi.unstubAllEnvs();
  });

  it('publishes a first-install key starting with no pending value', async () => {
    expect(await config.getEncryptionKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(await redis.get(pending)).toBeNull();
  });

  it('refuses to reserve when a key already exists', async () => {
    const existing = await redis.get(key);
    await store.reservePending(first);
    expect(await redis.get(pending)).toBeNull();
    expect(await redis.get(key)).toBe(existing);
  });

  it.each([null, second])(
    'refuses publication with a missing or changed pending: %j',
    async (saved) => {
      await redis.del(key);
      if (saved) await redis.set(pending, saved);
      await expect(store.publishPending(first)).rejects.toThrow('pending encryption key changed');
      expect(await redis.get(key)).toBeNull();
      expect(await redis.get(pending)).toBe(saved);
    },
  );

  it('publishes a matching pending only into an absent key and deletes the pending', async () => {
    await redis.del(key);
    await redis.set(pending, first);
    expect(await store.publishPending(first)).toBe(true);
    expect(await redis.get(key)).toBe(JSON.parse(first).key);
    expect(await redis.get(pending)).toBeNull();
  });

  it('preserves an existing key while deleting its matching pending', async () => {
    const existing = await redis.get(key);
    await redis.set(pending, first);
    expect(await store.publishPending(first)).toBe(false);
    expect(await redis.get(key)).toBe(existing);
    expect(await redis.get(pending)).toBeNull();
  });

  it('preserves a different pending when a key already exists', async () => {
    const existing = await redis.get(key);
    await redis.set(pending, second);
    expect(await store.publishPending(first)).toBe(false);
    expect(await redis.get(key)).toBe(existing);
    expect(await redis.get(pending)).toBe(second);
  });

  it('concurrent reservations retain one pending without allowing a losing retry to replace it', async () => {
    await redis.del(key);
    await Promise.all([store.reservePending(first), store.reservePending(second)]);
    const winner = await redis.get(pending);
    expect([first, second]).toContain(winner);
    await store.reservePending(winner === first ? second : first);
    expect(await redis.get(pending)).toBe(winner);
    expect(await redis.get(key)).toBeNull();
  });
});
