import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../src/db.js', () => ({ initDatabase: () => ({}) }));
vi.mock('../src/redis.js', () => ({ initRedis: vi.fn() }));
vi.mock('@haive/database', () => ({ waitForDatabaseReady: async () => undefined }));
vi.mock('@haive/shared', () => ({
  configService: { initialize: async () => undefined, getNumber: async () => 3001 },
  secretsService: {
    initialize: async () => undefined,
    getMasterKek: async () => Buffer.alloc(32),
    getJwtSecret: async () => 'jwt',
    getEmailBlindIndexPepper: async () => 'pepper',
  },
  userSecretsService: { initialize: async () => undefined },
  logger: { info: vi.fn(), warn: h.warn },
}));

import { bootstrap } from '../src/bootstrap.js';

beforeEach(() => {
  h.warn.mockClear();
  vi.stubEnv('DATABASE_URL', 'postgres://unused');
  vi.stubEnv('REDIS_URL', 'redis://unused');
  vi.stubEnv('WEB_ORIGIN', 'https://web.example.test');
  vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.test');
  vi.stubEnv('HAIVE_TRUSTED_PROXIES', '');
  vi.stubEnv('HAIVE_API_PORT', '3001');
});
afterEach(() => vi.unstubAllEnvs());

describe('cross-host web-proxy throttle warning at API boot', () => {
  it.each(['', '  ,  '])(
    'warns exactly once with the operator rule when the proxy list is empty (%j)',
    async (proxies) => {
      vi.stubEnv('HAIVE_TRUSTED_PROXIES', proxies);
      await bootstrap();
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(h.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          rule: 'docs/architecture/api-auth.md',
          section: 'Cross-host web-proxy mode',
        }),
        expect.stringContaining('HAIVE_TRUSTED_PROXIES'),
      );
    },
  );

  it.each(['172.20.0.0/16', '172.20.0.5, 172.20.0.1'])(
    'is silent when the operator has configured trusted proxies (%s)',
    async (proxies) => {
      vi.stubEnv('HAIVE_TRUSTED_PROXIES', proxies);
      await bootstrap();
      expect(h.warn).not.toHaveBeenCalled();
    },
  );

  it('is silent when hostnames match even if scheme and port differ', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'http://web.example.test:3001');
    await bootstrap();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('is silent when the browser API host derives from the web host', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
    await bootstrap();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('does not turn invalid URL configuration into a bootstrap failure', async () => {
    vi.stubEnv('HAIVE_PUBLIC_API_URL', 'invalid');
    await expect(bootstrap()).resolves.toMatchObject({ apiPort: 3001 });
    expect(h.warn).not.toHaveBeenCalled();
  });
});
