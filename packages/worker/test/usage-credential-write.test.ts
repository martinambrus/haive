import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, secretsService } from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
const h = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  read: vi.fn(),
  refresh: vi.fn(),
}));
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

function setup() {
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
    isolateAuth: true,
    enabled: true,
    authGeneration: '00000000-0000-4000-8000-000000000001',
  });
  return fake;
}
beforeEach(() => {
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockClear();
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
afterEach(() => vi.restoreAllMocks());
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
it('does not read or refresh while sign-out or a credential writer owns the scope', async () => {
  const fake = setup();
  h.acquire.mockResolvedValueOnce(null);
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(0);
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
