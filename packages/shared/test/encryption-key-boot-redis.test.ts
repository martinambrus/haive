import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { Redis } from 'ioredis';
import type { Database } from '@haive/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS, ConfigService } from '../src/config/config.service.js';
import * as boot from '../src/config/encryption-key-boot.js';
import { ConfigUnavailableError } from '../src/config/config-unavailable.js';

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

// Independent processes keep their own startup environment throughout the interleaving.
function bootProcess(redisUrl: string, envKey: string) {
  const child = fork(new URL('./fixtures/encryption-key-boot-process.ts', import.meta.url), [], {
    execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
    env: {
      ...process.env,
      REDIS_URL: redisUrl,
      CONFIG_ENCRYPTION_KEY: envKey,
      HAIVE_DISCARD_UNREADABLE_SECRETS: '1',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages: Record<string, unknown>[] = [];
  let receive: ((value: Record<string, unknown>) => void) | undefined;
  child.on('message', (message) => {
    if (receive) {
      const resolve = receive;
      receive = undefined;
      resolve(message as Record<string, unknown>);
    } else messages.push(message as Record<string, unknown>);
  });
  return {
    child,
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift()!)
        : new Promise<Record<string, unknown>>((resolve) => {
            receive = resolve;
          }),
  };
}

describe.skipIf(!url)('boot encryption key atomic Redis store', () => {
  let redis: Redis;
  let config: ConfigService;
  const waitMs = 10_000;
  let store: Parameters<typeof boot.generateBootEncryptionKey>[1];

  beforeAll(async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
    vi.stubEnv('HAIVE_DISCARD_UNREADABLE_SECRETS', '');
    redis = new Redis(url!);
    await redis.ping();
  });
  beforeEach(async () => {
    await redis.del(key, pending);
    config = new ConfigService(waitMs);
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

  it.each(['pending-first', 'env-first'] as const)(
    'serializes the restored-key/discard race across processes: %s',
    async (order) => {
      await redis.del(key, pending);
      const original = 'ef'.repeat(32);
      const a = bootProcess(url!, '');
      const b = bootProcess(url!, original);
      try {
        a.child.send('boot');
        expect(await a.next()).toMatchObject({ event: 'inventory' });
        if (order === 'pending-first') {
          a.child.send('reserve');
          expect(await a.next()).toMatchObject({ event: 'reserved' });
          b.child.send('boot');
          const restoredBoot = await b.next();
          a.child.send('commit');
          expect(await a.next()).toMatchObject({ event: 'done', discarded: true });
          expect(await redis.get(key)).not.toBe(original);
          expect(restoredBoot).toMatchObject({ event: 'error', retryable: true });
          expect(await redis.get(pending)).toBeNull();
          b.child.send('boot');
          expect(await b.next()).toMatchObject({
            event: 'error',
            retryable: false,
            message: expect.stringContaining('does not match'),
          });
        } else {
          b.child.send('boot');
          expect(await b.next()).toMatchObject({ event: 'done', discarded: false, key: original });
          a.child.send('reserve');
          expect(await a.next()).toMatchObject({ event: 'done', discarded: false, key: original });
          expect(await redis.get(key)).toBe(original);
          expect(await redis.get(pending)).toBeNull();
        }
      } finally {
        await Promise.all(
          [a.child, b.child].map(
            (child: ChildProcess) =>
              new Promise<void>((resolve) => {
                child.once('exit', () => resolve());
                child.kill();
              }),
          ),
        );
      }
    },
  );

  it('blocks fallback recovery behind a pending reservation on real Redis', async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'ef'.repeat(32));
    try {
      await redis.del(key);
      await redis.set(pending, JSON.stringify({ ...JSON.parse(first), reservedAt: Date.now() }));
      const reserved = await redis.get(pending);
      config.clearCache();
      await expect(config.getEncryptionKey()).rejects.toBeInstanceOf(ConfigUnavailableError);
      expect(await redis.get(key)).toBeNull();
      expect(await redis.get(pending)).toBe(reserved);
    } finally {
      vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
    }
  });

  it.each([
    ['young', (): string => JSON.stringify({ ...JSON.parse(first), reservedAt: Date.now() }), true],
    [
      'old',
      (): string => JSON.stringify({ ...JSON.parse(first), reservedAt: Date.now() - waitMs - 1 }),
      false,
    ],
    ['legacy', (): string => first, false],
    ['invalid timestamp', (): string => JSON.stringify({ reservedAt: 'broken' }), false],
    ['corrupt JSON', (): string => '{broken', false],
    ['nonfinite timestamp', (): string => '{"reservedAt":NaN}', false],
  ] as const)(
    'classifies %s pending atomically on boot and fallback',
    async (_label, value, retryable) => {
      vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'ef'.repeat(32));
      try {
        for (const path of ['boot', 'fallback']) {
          await redis.del(key);
          const reserved = value();
          await redis.set(pending, reserved);
          config.clearCache();
          const svc = path === 'boot' ? new ConfigService(waitMs) : config;
          try {
            const error = await (
              path === 'boot' ? svc.initialize(url!) : svc.getEncryptionKey()
            ).catch((e) => e);
            expect(error).toBeInstanceOf(Error);
            if (retryable) {
              expect(error).toBeInstanceOf(ConfigUnavailableError);
              expect(error.cause.message).toContain('secret discard is in progress');
            } else {
              expect(error).not.toBeInstanceOf(ConfigUnavailableError);
              expect(error.message).toContain(pending);
              expect(error.message).toContain('interrupted secret discard');
            }
            expect(await redis.get(key)).toBeNull();
            expect(await redis.get(pending)).toBe(reserved);
          } finally {
            if (path === 'boot') await svc.close();
          }
        }
      } finally {
        vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
      }
    },
  );

  it('seeds a healthy environment key when no pending exists', async () => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', 'ef'.repeat(32));
    const svc = new ConfigService();
    try {
      await redis.del(key, pending);
      await svc.initialize(url!);
      expect(await svc.getEncryptionKey()).toBe('ef'.repeat(32));
      expect(await redis.get(pending)).toBeNull();
    } finally {
      await svc.close();
      vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
    }
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
