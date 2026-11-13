import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  transactionOpen: false,
  publish: vi.fn<(...args: string[]) => Promise<number>>(),
  warn: vi.fn(),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ publish: h.publish }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
}));
vi.mock('@haive/shared', async (original) => {
  const shared = await original<typeof import('@haive/shared')>();
  const log = { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { ...shared, logger: log };
});

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { DEFAULT_AGENT_RULES, TERMINAL_REQUEST_CHANNEL } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(userId = USER) {
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    cliProviders: schema.cliProviders,
    cliProviderSecrets: schema.cliProviderSecrets,
  });
  fake.insert(schema.cliProviders, {
    id: PROVIDER,
    userId,
    name: 'claude-code',
    label: 'CLI',
    enabled: true,
    rulesContent: DEFAULT_AGENT_RULES,
    authMode: 'subscription',
    isolateAuth: false,
  });
  const transaction = fake.db.transaction.bind(fake.db);
  fake.db.transaction = async (fn) => {
    h.transactionOpen = true;
    try {
      return await transaction(fn);
    } finally {
      h.transactionOpen = false;
    }
  };
  h.db = fake.db;
  return fake;
}
function patch(body: Record<string, unknown>) {
  return app.request(`/${PROVIDER}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const closeRequest = { op: 'close-provider', userId: USER, cliProviderId: PROVIDER };
beforeEach(() => {
  h.publish.mockReset().mockResolvedValue(1);
  h.warn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('provider shell revocation', () => {
  it.each(['PATCH', 'DELETE'])(
    'publishes an owner-scoped close after %s commits',
    async (method) => {
      const fake = setup();
      h.publish.mockImplementation(async () => {
        expect(h.transactionOpen).toBe(false);
        expect(fake.rows(schema.auditEvents)).toHaveLength(1);
        expect(fake.rows(schema.cliProviders)).toEqual(
          method === 'DELETE' ? [] : [expect.objectContaining({ enabled: false })],
        );
        return 1;
      });
      const response =
        method === 'PATCH'
          ? await patch({ enabled: false })
          : await app.request(`/${PROVIDER}`, { method });
      expect(response.status).toBe(200);
      expect(h.publish).toHaveBeenCalledExactlyOnceWith(
        TERMINAL_REQUEST_CHANNEL,
        JSON.stringify(closeRequest),
      );
    },
  );

  it.each(['PATCH', 'DELETE'])(
    'keeps the committed %s successful and logs publication failure',
    async (method) => {
      const fake = setup();
      const err = new Error('Redis unavailable');
      h.publish.mockRejectedValueOnce(err);
      const response =
        method === 'PATCH'
          ? await patch({ enabled: false })
          : await app.request(`/${PROVIDER}`, { method });
      expect(response.status).toBe(200);
      expect(fake.rows(schema.cliProviders)).toEqual(
        method === 'DELETE' ? [] : [expect.objectContaining({ enabled: false })],
      );
      expect(h.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err, userId: USER, providerId: PROVIDER }),
        expect.any(String),
      );
    },
  );

  it('does not reopen shells on enable or close them on an unrelated edit', async () => {
    setup();
    expect((await patch({ enabled: true })).status).toBe(200);
    expect((await patch({ label: 'Renamed' })).status).toBe(200);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(['PATCH', 'DELETE'])(
    'publishes nothing when %s is refused for another owner',
    async (method) => {
      setup('00000000-0000-4000-8000-0000000000a2');
      const response =
        method === 'PATCH'
          ? await patch({ enabled: false })
          : await app.request(`/${PROVIDER}`, { method });
      expect(response.status).toBe(404);
      expect(h.publish).not.toHaveBeenCalled();
    },
  );

  it('publishes nothing when the transaction fails', async () => {
    const fake = setup();
    vi.spyOn(fake.db, 'transaction').mockRejectedValueOnce(new Error('transaction refused'));
    expect((await patch({ enabled: false })).status).toBe(500);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({ enabled: true });
    expect(h.publish).not.toHaveBeenCalled();
  });
});
