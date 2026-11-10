import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigService,
  CONFIG_KEYS,
  PRIVATE_ENDPOINT_SEED_STATE_KEY,
} from '../src/config/index.js';

const url = process.env.CONFIG_SEED_REDIS_TEST_URL;
if (url && !/^redis:\/\/127\.0\.0\.1:\d+\/4$/.test(url)) {
  throw new Error('Use a dedicated loopback Redis database 4');
}
const key = CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST;
describe.skipIf(!url)('private endpoint seed atomic Redis store', () => {
  const config = new ConfigService();
  beforeAll(async () => {
    await config.initialize(url!);
  });
  beforeEach(async () => {
    await config.getRedis().del(key, PRIVATE_ENDPOINT_SEED_STATE_KEY);
    config.clearCache();
  });
  afterAll(async () => {
    await config.close();
  });

  it('keeps an unresolved seed absent and atomically publishes progress and the retry state', async () => {
    expect(await config.comparePrivateEndpointSeed(null, null, null, 'pending-1')).toBe(true);
    expect(await config.getFresh(key)).toBeNull();
    expect(await config.getFresh(PRIVATE_ENDPOINT_SEED_STATE_KEY)).toBe('pending-1');
    expect(await config.comparePrivateEndpointSeed(null, 'pending-1', 'one.lan', 'pending-2')).toBe(
      true,
    );
    expect(await config.getFresh(key)).toBe('one.lan');
    expect(
      await config.comparePrivateEndpointSeed('one.lan', 'pending-2', 'one.lan\ntwo.lan', 'done'),
    ).toBe(true);
    expect(await config.getFresh(key)).toBe('one.lan\ntwo.lan');
  });

  it.each(['', 'admin.lan', 'one.lan'])(
    'an admin save of %j invalidates seed ownership atomically',
    async (saved) => {
      await config.comparePrivateEndpointSeed(null, null, 'one.lan', 'pending');
      await config.set(key, saved);
      expect(await config.getFresh(PRIVATE_ENDPOINT_SEED_STATE_KEY)).toBeNull();
      expect(
        await config.comparePrivateEndpointSeed('one.lan', 'pending', 'one.lan\ntwo.lan', 'done'),
      ).toBe(false);
      expect(await config.getFresh(key)).toBe(saved);
    },
  );

  it('rejects a changed value and a stale state without writing either key', async () => {
    await config.comparePrivateEndpointSeed(null, null, 'one.lan', 'pending');
    expect(await config.comparePrivateEndpointSeed('other.lan', 'pending', 'bad', 'bad')).toBe(
      false,
    );
    expect(await config.comparePrivateEndpointSeed('one.lan', 'stale', 'bad', 'bad')).toBe(false);
    expect(await config.getFresh(key)).toBe('one.lan');
    expect(await config.getFresh(PRIVATE_ENDPOINT_SEED_STATE_KEY)).toBe('pending');
  });

  it('allows only one concurrent initial writer', async () => {
    const results = await Promise.all([
      config.comparePrivateEndpointSeed(null, null, 'one.lan', 'one'),
      config.comparePrivateEndpointSeed(null, null, 'two.lan', 'two'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const stored = await config.getFresh(key);
    expect(await config.getFresh(PRIVATE_ENDPOINT_SEED_STATE_KEY)).toBe(
      stored === 'one.lan' ? 'one' : 'two',
    );
  });
});
