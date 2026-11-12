const authLock = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  ),
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: authLock.acquire,
}));
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  redis: undefined as unknown,
  user: '',
  fetch: vi.fn(),
  pollAdd: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', h.user);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: vi.fn() }),
  getUsagePollQueue: () => ({ add: h.pollAdd }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { DEFAULT_AGENT_RULES, envelopeDecrypt, secretsService } from '@haive/shared';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const KEK = 'ab'.repeat(32);
const CODE = 'auth-code-from-claude';
const TOKENS = {
  access_token: 'at-1',
  refresh_token: 'rt-1',
  expires_in: 28800,
  scope: 'org:create_api_key user:profile user:inference',
};

const redisUrl = process.env.USAGE_AUTH_TEST_REDIS_URL;
const realRedis = redisUrl ? new Redis(redisUrl) : null;

// A hop before every command, as on a socket, so requests interleave at Redis.
function memoryRedis() {
  const store = new Map<string, string>();
  const hop = () => new Promise((resolve) => setImmediate(resolve));
  return {
    set: async (key: string, value: string) => {
      await hop();
      store.set(key, value);
      return 'OK';
    },
    get: async (key: string) => {
      await hop();
      return store.get(key) ?? null;
    },
    del: async (key: string) => {
      await hop();
      return store.delete(key) ? 1 : 0;
    },
    // Transcribes the take script, which only runs for real when USAGE_AUTH_TEST_REDIS_URL is set.
    eval: async (_script: string, _keys: number, key: string, state: string) => {
      await hop();
      const raw = store.get(key);
      if (raw === undefined) return null;
      if ((JSON.parse(raw) as { state?: string }).state !== state) return 0;
      store.delete(key);
      return raw;
    },
  };
}

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

let fake: ReturnType<typeof createFakeDb>;

beforeEach(() => {
  authLock.acquire.mockReset().mockResolvedValue(authLock.release);
  authLock.release.mockClear();
  authLock.release.assertHeld.mockReset().mockResolvedValue(undefined);
  h.user = randomUUID();
  h.redis = realRedis ?? memoryRedis();
  h.pollAdd.mockClear();
  h.fetch.mockReset();
  h.fetch.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify(TOKENS), { status: 200 });
  });
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  fake = createFakeDb({
    auditEvents: schema.auditEvents,
    cliProviders: schema.cliProviders,
    cliProviderSecrets: schema.cliProviderSecrets,
  });
  fake.insert(schema.cliProviders, {
    id: PROVIDER,
    userId: h.user,
    name: 'claude-code',
    label: 'p',
    rulesContent: DEFAULT_AGENT_RULES,
  });
  h.db = fake.db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await realRedis?.quit();
});

const post = (path: string, body: Record<string, unknown> = {}) =>
  app.request(`/${PROVIDER}/usage-auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function startAuthorization() {
  const { authorizeUrl } = (await (await post('start')).json()) as { authorizeUrl: string };
  const params = new URL(authorizeUrl).searchParams;
  return { state: params.get('state')!, challenge: params.get('code_challenge')! };
}

const exchanges = () =>
  h.fetch.mock.calls.map(([, init]) => new URLSearchParams((init as { body: string }).body));

function storedTokens() {
  const row = fake
    .rows(schema.cliProviderSecrets)
    .find((r) => r.secretName === CLAUDE_USAGE_OAUTH_SECRET)!;
  const value = envelopeDecrypt(
    { encryptedValue: row.encryptedValue as string, encryptedDek: row.encryptedDek as string },
    KEK,
  );
  return JSON.parse(value) as { accessToken: string; refreshToken: string };
}

describe('POST /:providerId/usage-auth/complete', () => {
  it('connects with the pasted code#state, exchanging the stashed verifier once', async () => {
    const { state, challenge } = await startAuthorization();
    const res = await post('complete', { code: `${CODE}#${state}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      connected: true,
      scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
    });
    expect(exchanges()).toHaveLength(1);
    const sent = exchanges()[0]!;
    expect(sent.get('code')).toBe(CODE);
    expect(sent.get('state')).toBe(state);
    const verifier = sent.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(storedTokens()).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
    expect(h.pollAdd).toHaveBeenCalledTimes(1);

    const replay = await post('complete', { code: `${CODE}#${state}` });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: expect.stringContaining('expired or not started'),
    });
    expect(exchanges()).toHaveLength(1);
  });

  it('exchanges once when two completes carry the same code', async () => {
    const { state } = await startAuthorization();
    const paste = { code: `${CODE}#${state}` };
    const results = await Promise.all([post('complete', paste), post('complete', paste)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 400]);
    const refused = results.find((r) => r.status === 400)!;
    expect(await refused.json()).toMatchObject({
      error: expect.stringContaining('expired or not started'),
    });
    expect(exchanges()).toHaveLength(1);
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(1);
  });

  it.each([CODE, `${CODE}#`])(
    'refuses the paste "%s" without a state part, keeping the stash',
    async (pasted) => {
      const { state } = await startAuthorization();
      const res = await post('complete', { code: pasted });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining('missing its state part'),
      });
      expect(exchanges()).toHaveLength(0);
      expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);

      const retry = await post('complete', { code: `${CODE}#${state}` });
      expect(retry.status).toBe(200);
      expect(exchanges()).toHaveLength(1);
    },
  );

  it('refuses a paste with another state, keeping the stash for the right one', async () => {
    const { state } = await startAuthorization();
    const res = await post('complete', { code: `${CODE}#not-the-state` });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('belongs to a different authorization'),
    });
    expect(exchanges()).toHaveLength(0);
    expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);

    const retry = await post('complete', { code: `${CODE}#${state}` });
    expect(retry.status).toBe(200);
    expect(exchanges()).toHaveLength(1);
  });
});

it('fences a usage reconnect and advances the generation', async () => {
  const before = fake.rows(schema.cliProviders)[0]!.authGeneration;
  const { state } = await startAuthorization();
  expect((await post('complete', { code: `${CODE}#${state}` })).status).toBe(200);
  expect(fake.rows(schema.cliProviders)[0]!.authGeneration).not.toBe(before);
  expect(authLock.acquire).toHaveBeenCalledOnce();
  expect(authLock.release).toHaveBeenCalledOnce();
  expect(authLock.release.mock.invocationCallOrder[0]).toBeLessThan(
    h.pollAdd.mock.invocationCallOrder[0]!,
  );
});
it('refuses a busy usage reconnect without consuming its authorization', async () => {
  const { state } = await startAuthorization();
  authLock.acquire.mockResolvedValueOnce(null);
  const paste = { code: `${CODE}#${state}` };
  const busy = await post('complete', paste);
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({
    code: 'cli_auth_busy',
    error:
      'CLI authentication is busy. Finish the current sign-in or credential update and try again.',
  });
  expect(h.fetch).not.toHaveBeenCalled();
  expect((await post('complete', paste)).status).toBe(200);
});

it('keeps a usage authorization retryable when settings change before the stash is taken', async () => {
  const { state } = await startAuthorization();
  authLock.acquire.mockImplementationOnce(async () => {
    const provider = fake.rows(schema.cliProviders)[0]!;
    fake.patch(schema.cliProviders, PROVIDER, { isolateAuth: !provider.isolateAuth });
    return authLock.release;
  });
  const paste = { code: `${CODE}#${state}` };
  const refused = await post('complete', paste);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: 'cli_auth_busy',
    error: 'CLI authentication settings changed. Reload and try again.',
  });
  expect(h.fetch).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
  expect(h.pollAdd).not.toHaveBeenCalled();
  expect(authLock.release).toHaveBeenCalledOnce();
  expect((await post('complete', paste)).status).toBe(200);
  expect(h.fetch).toHaveBeenCalledOnce();
});

it.each(['exchange', 'write'])(
  'rolls back usage OAuth after lock loss during %s',
  async (phase) => {
    const { state } = await startAuthorization();
    const before = fake.rows(schema.cliProviders);
    const lose = () => {
      authLock.release.assertHeld.mockRejectedValue(new Error('lock lost'));
    };
    const transaction = vi.spyOn(fake.db, 'transaction');
    if (phase === 'exchange')
      h.fetch.mockImplementationOnce(async () => {
        expect(transaction).not.toHaveBeenCalled();
        lose();
        return new Response(JSON.stringify(TOKENS), { status: 200 });
      });
    else fake.hooks.beforeUpdate = async () => lose();
    const res = await post('complete', { code: CODE + '#' + state });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'cli_auth_busy',
      error: 'CLI authentication changed. Start a new usage connection and authorize again.',
    });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect((await post('complete', { code: CODE + '#' + state })).status).toBe(400);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(fake.rows(schema.cliProviderSecrets)).toEqual([]);
    expect(fake.rows(schema.cliProviders)).toEqual(before);
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(h.pollAdd).not.toHaveBeenCalled();
  },
);
