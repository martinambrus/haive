import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, secretsService } from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
const h = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  ),
  read: vi.fn(),
  refresh: vi.fn(),
  fetch: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@haive/shared', async (original) => {
  const actual = await original<typeof import('@haive/shared')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      child(bindings: Record<string, unknown>) {
        const child = actual.logger.child(bindings);
        if (bindings.module === 'usage-poll') child.debug = h.debug;
        return child;
      },
    },
  };
});
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
vi.mock('../src/usage-window/token-source.js', async (original) => ({
  ...(await original<typeof import('../src/usage-window/token-source.js')>()),
  readProviderSecretToken: h.read,
}));
vi.mock('@haive/shared/claude-oauth', async (original) => ({
  ...(await original<typeof import('@haive/shared/claude-oauth')>()),
  refreshClaudeToken: h.refresh,
}));
vi.mock('../src/cli-adapters/probe-fetch.js', () => ({
  resolveProbeFetch: async () => async () => new Response('{}'),
}));
import { runUsagePollTick } from '../src/queues/usage-poll-queue.js';
import { writeProviderSecret } from '../src/usage-window/token-source.js';
import { handleSignOutJob } from '../src/queues/cli-exec-queue.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

function setup(isolateAuth = true) {
  const fake = createFakeDb({
    cliProviders: schema.cliProviders,
    cliProviderSecrets: schema.cliProviderSecrets,
    usageWindowSnapshots: schema.usageWindowSnapshots,
  });
  fake.insert(schema.cliProviders, {
    id: randomUUID(),
    userId: randomUUID(),
    name: 'claude-code',
    label: 'test',
    authMode: 'subscription',
    isolateAuth,
    enabled: true,
    authGeneration: '00000000-0000-4000-8000-000000000001',
  });
  return fake;
}
beforeEach(() => {
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockClear();
  h.debug.mockClear();
  h.fetch
    .mockReset()
    .mockImplementation(async () => Response.json({ five_hour: { utilization: 12 } }));
  vi.stubGlobal('fetch', h.fetch);
  h.read
    .mockReset()
    .mockResolvedValue(
      JSON.stringify({ accessToken: 'old', refreshToken: 'refresh', expiresAt: 0 }),
    );
  h.refresh.mockReset().mockResolvedValue({
    accessToken: 'new',
    refreshToken: 'rotated',
    expiresAt: Date.now() + 100000,
  });
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'get').mockResolvedValue('off');
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue('ab'.repeat(32));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('holds the shared scope across the usage credential read, grant and write without advancing the login generation', async () => {
  const fake = setup();
  h.refresh.mockImplementation(async () => {
    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    return { accessToken: 'new', refreshToken: 'rotated', expiresAt: Date.now() + 100000 };
  });
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.acquire).toHaveBeenCalledWith(
    fake.db,
    cliAuthScope(fake.rows(schema.cliProviders)[0] as any),
  );
  expect(h.refresh).toHaveBeenCalledOnce();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(1);
  expect(fake.rows(schema.cliProviders)[0]!.authGeneration).toBe(
    '00000000-0000-4000-8000-000000000001',
  );
  expect(h.release).toHaveBeenCalledOnce();
});
it('a usage refresh after a sign-out request still removes the volumes and both Claude secrets', async () => {
  const fake = setup();
  const provider = fake.rows(schema.cliProviders)[0]!;
  const payload = {
    providerId: provider.id as string,
    userId: provider.userId as string,
    authGeneration: provider.authGeneration as string,
  };
  fake.insert(schema.cliProviderSecrets, {
    providerId: provider.id,
    secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
    encryptedValue: 'login',
    encryptedDek: 'login',
  });
  const volume = cliAuthScope(provider as any);
  const volumes = new Set([volume]);
  const runner = {
    volumeExists: async (name: string) => volumes.has(name),
    volumeRemove: async (name: string) => {
      volumes.delete(name);
      return { ok: true, stderr: '' };
    },
  } as DockerRunner;
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.refresh).toHaveBeenCalledOnce();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(2);
  expect(await handleSignOutJob(fake.db as unknown as Database, payload, runner)).toEqual({
    ok: true,
    removed: [volume],
    failed: [],
  });
  expect(volumes.size).toBe(0);
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  expect(fake.rows(schema.cliProviders)[0]!.authStatus).toBe('unknown');
});
it('logs and skips refresh while sign-out or a credential writer owns the scope', async () => {
  const fake = setup();
  h.acquire.mockResolvedValueOnce(null);
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.read).toHaveBeenCalledOnce();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  expect(h.debug).toHaveBeenCalledWith(
    { providerId: fake.rows(schema.cliProviders)[0]!.id },
    expect.any(String),
  );
});
it('leaves the usage secret and login generation unchanged when the upsert fails', async () => {
  const fake = setup();
  fake.hooks.beforeInsert = async () => {
    throw new Error('upsert refused');
  };
  await expect(
    writeProviderSecret(
      fake.db as unknown as Database,
      fake.rows(schema.cliProviders)[0]!.id as string,
      'CLAUDE_USAGE_OAUTH',
      'new',
    ),
  ).rejects.toThrow('upsert refused');
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  expect(fake.rows(schema.cliProviders)[0]!.authGeneration).toBe(
    '00000000-0000-4000-8000-000000000001',
  );
});

it('polls two same-scope providers in one tick without locking when no refresh is due', async () => {
  const fake = setup(false);
  const first = fake.rows(schema.cliProviders)[0]!;
  fake.insert(schema.cliProviders, { ...first, id: randomUUID() });
  const scopes = new Set<string>();
  h.acquire.mockImplementation(async (_db, scope: string) => {
    if (scopes.has(scope)) return null;
    scopes.add(scope);
    return async () => {
      scopes.delete(scope);
    };
  });
  h.read.mockResolvedValue(
    JSON.stringify({
      accessToken: 'fresh',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3600000,
    }),
  );
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(
    fake
      .rows(schema.usageWindowSnapshots)
      .map((row) => row.providerId)
      .sort(),
  ).toEqual(
    fake
      .rows(schema.cliProviders)
      .map((row) => row.id)
      .sort(),
  );
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
});

it.each([
  [null, null],
  ['invalid JSON', null],
  [JSON.stringify({ refreshToken: 'no-access' }), null],
  [
    JSON.stringify({ accessToken: 'already-refreshed', refreshToken: 'rotated', expiresAt: 1e15 }),
    'already-refreshed',
  ],
])('re-reads credentials under the refresh lock before using %s', async (raw, token) => {
  const fake = setup();
  h.acquire.mockImplementationOnce(async () => {
    h.read.mockResolvedValue(raw);
    return h.release;
  });
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
  if (token) {
    expect(h.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
  } else {
    expect(h.fetch).not.toHaveBeenCalled();
  }
  expect(h.release).toHaveBeenCalledOnce();
});

it('refreshes using the token re-read under the lock', async () => {
  const fake = setup();
  h.read.mockResolvedValueOnce(
    JSON.stringify({ accessToken: 'obsolete', refreshToken: 'spent', expiresAt: 0 }),
  );
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.refresh).toHaveBeenCalledWith('refresh');
  expect(h.release).toHaveBeenCalledOnce();
});
