import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, secretsService } from '@haive/shared';

const h = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  ),
  read: vi.fn(),
  logged: [] as unknown[][],
}));
vi.mock('@haive/shared', async (original) => {
  const actual = await original<typeof import('@haive/shared')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      child(bindings: Record<string, unknown>) {
        const child = actual.logger.child(bindings);
        if (bindings.module === 'usage-poll') {
          for (const level of ['debug', 'info', 'warn', 'error'] as const) {
            child[level] = ((...args: unknown[]) => {
              h.logged.push(args);
            }) as never;
          }
        }
        return child;
      },
    },
  };
});
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
vi.mock('../src/usage-window/usage-grant-set.js', async (original) => ({
  ...(await original<typeof import('../src/usage-window/usage-grant-set.js')>()),
  pickGrantHolder: async (_db: unknown, rep: { id: string }) => {
    const raw = (await h.read()) as string;
    return { providerId: rep.id, encryptedValue: raw, encryptedDek: 'dek', grant: JSON.parse(raw) };
  },
  convergeSetCopies: async (_tx: unknown, _rep: unknown, holder: { providerId: string }) => ({
    events: [],
    copyIds: [holder.providerId],
  }),
}));
vi.mock('../src/cli-adapters/probe-fetch.js', () => ({
  resolveProbeFetch: async () => async () => new Response('{}'),
}));
import { runUsagePollTick } from '../src/queues/usage-poll-queue.js';

const GRANT = JSON.stringify({ accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 });

function setup() {
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    cliProviderSecrets: schema.cliProviderSecrets,
    usageWindowSnapshots: schema.usageWindowSnapshots,
  });
  const id = randomUUID();
  fake.insert(schema.cliProviders, {
    id,
    userId: randomUUID(),
    name: 'claude-code',
    label: 'test',
    authMode: 'subscription',
    isolateAuth: true,
    enabled: true,
    authGeneration: '00000000-0000-4000-8000-000000000001',
  });
  fake.insert(schema.cliProviderSecrets, {
    providerId: id,
    secretName: 'CLAUDE_USAGE_OAUTH',
    encryptedValue: GRANT,
    encryptedDek: 'dek',
  });
  return { fake, id };
}

function endpoint(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) =>
      String(url).endsWith('/oauth/token')
        ? new Response(body, { status })
        : Response.json({ five_hour: { utilization: 12 } }),
    ),
  );
}

beforeEach(() => {
  h.logged.length = 0;
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockClear();
  h.release.assertHeld.mockReset().mockResolvedValue(undefined);
  h.read.mockReset().mockResolvedValue(GRANT);
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'get').mockResolvedValue('off');
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue('ab'.repeat(32));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function logText(): string {
  return JSON.stringify(h.logged, (_key, value) =>
    value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value,
  );
}

it('logs a refused refresh with its provider and status, never the endpoint text', async () => {
  const tok = randomBytes(16).toString('hex');
  const { fake, id } = setup();
  endpoint(503, `upstream ${tok}`);
  await runUsagePollTick(fake.db as unknown as Database);
  const text = logText();
  expect(text).toContain('claude usage token refresh failed');
  expect(text).toContain(id);
  expect(text).toContain('http 503');
  expect(text).not.toContain(tok);
});

it('still marks a rejected refresh needs_reconnect without logging the endpoint text', async () => {
  const tok = randomBytes(16).toString('hex');
  const { fake } = setup();
  endpoint(400, JSON.stringify({ error: 'invalid_grant', error_description: tok }));
  await runUsagePollTick(fake.db as unknown as Database);
  expect(fake.rows(schema.usageWindowSnapshots)).toMatchObject([{ status: 'needs_reconnect' }]);
  expect(logText()).not.toContain(tok);
});
