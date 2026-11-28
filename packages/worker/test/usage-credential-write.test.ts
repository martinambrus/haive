import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, secretsService, envelopeDecrypt } from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { ClaudeOauthError } from '@haive/shared/claude-oauth';
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
// The fake db cannot join snapshots to secrets or update one row from another: the holder is
// built from the mocked read, its ciphertext identity being the stored string, and convergence is
// pinned by the real-database controls. The rotation write stays real.
vi.mock('../src/usage-window/usage-grant-set.js', async (original) => ({
  ...(await original<typeof import('../src/usage-window/usage-grant-set.js')>()),
  pickGrantHolder: async (_db: unknown, rep: { id: string }) => {
    const raw = (await h.read()) as string | null;
    if (!raw) return null;
    try {
      const grant = JSON.parse(raw);
      if (!grant?.accessToken) return null;
      return { providerId: rep.id, encryptedValue: raw, encryptedDek: 'dek', grant };
    } catch {
      return null;
    }
  },
  convergeSetCopies: async (_tx: unknown, _rep: unknown, holder: { providerId: string }) => ({
    events: [],
    copyIds: [holder.providerId],
  }),
}));
vi.mock('@haive/shared/claude-oauth', async (original) => ({
  ...(await original<typeof import('@haive/shared/claude-oauth')>()),
  refreshClaudeToken: h.refresh,
}));
vi.mock('../src/cli-adapters/probe-fetch.js', () => ({
  resolveProbeFetch: async () => async () => new Response('{}'),
}));
import { runUsagePollTick } from '../src/queues/usage-poll-queue.js';
import { rotateGrantCopies } from '../src/usage-window/usage-grant-set.js';
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
const KEK = 'ab'.repeat(32);
const OLD_ACCESS = randomUUID();
const OLD_REFRESH = randomUUID();
const NEW_ACCESS = randomUUID();
const NEW_REFRESH = randomUUID();
const CLI_LOGIN = randomUUID();
const REPLACEMENT_ACCESS = randomUUID();
const SPENT_REFRESH = randomUUID();
const GRANT = JSON.stringify({ accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, expiresAt: 0 });
/** The stored copy of the grant the mocked read returns, as the rotation write finds it. */
function seedGrant(fake: ReturnType<typeof setup>) {
  fake.insert(schema.cliProviderSecrets, {
    providerId: fake.rows(schema.cliProviders)[0]!.id,
    secretName: 'CLAUDE_USAGE_OAUTH',
    encryptedValue: GRANT,
    encryptedDek: 'dek',
  });
}
beforeEach(() => {
  h.acquire.mockReset().mockResolvedValue(h.release);
  h.release.mockClear();
  h.release.assertHeld.mockReset().mockResolvedValue(undefined);
  h.debug.mockClear();
  h.fetch
    .mockReset()
    .mockImplementation(async () => Response.json({ five_hour: { utilization: 12 } }));
  vi.stubGlobal('fetch', h.fetch);
  h.read.mockReset().mockResolvedValue(GRANT);
  h.refresh.mockReset().mockResolvedValue({
    accessToken: NEW_ACCESS,
    refreshToken: NEW_REFRESH,
    expiresAt: Date.now() + 100000,
  });
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'get').mockResolvedValue('off');
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('holds the shared scope across the usage credential read, grant and write without advancing the login generation', async () => {
  const fake = setup();
  seedGrant(fake);
  h.refresh.mockImplementation(async () => {
    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    return { accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, expiresAt: Date.now() + 100000 };
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
  expect(h.release).toHaveBeenCalledTimes(2);
});
it('a usage refresh after a sign-out request still removes the volumes and both Claude secrets', async () => {
  const fake = setup();
  seedGrant(fake);
  const provider = fake.rows(schema.cliProviders)[0]!;
  const payload = {
    providerId: provider.id as string,
    userId: provider.userId as string,
    authGeneration: provider.authGeneration as string,
  };
  fake.insert(schema.cliProviderSecrets, {
    providerId: provider.id,
    secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
    encryptedValue: CLI_LOGIN,
    encryptedDek: CLI_LOGIN,
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
it('leaves the usage secret and login generation unchanged when the rotation update fails', async () => {
  const fake = setup();
  seedGrant(fake);
  const provider = fake.rows(schema.cliProviders)[0]!;
  fake.hooks.beforeUpdate = async () => {
    throw new Error('update refused');
  };
  await expect(
    rotateGrantCopies(
      fake.db as unknown as Database,
      provider as any,
      {
        providerId: provider.id as string,
        encryptedValue: GRANT,
        encryptedDek: 'dek',
        grant: JSON.parse(GRANT),
      },
      {
        accessToken: NEW_ACCESS,
        refreshToken: NEW_REFRESH,
        expiresAt: Date.now() + 100000,
        scopes: [],
      },
      KEK,
    ),
  ).rejects.toThrow('update refused');
  expect(fake.rows(schema.cliProviderSecrets)).toHaveLength(1);
  expect(fake.rows(schema.cliProviderSecrets)[0]!.encryptedValue).toBe(GRANT);
  expect(fake.rows(schema.cliProviders)[0]!.authGeneration).toBe(
    '00000000-0000-4000-8000-000000000001',
  );
});

it.each([
  [null, null],
  ['invalid JSON', null],
  [JSON.stringify({ refreshToken: randomUUID() }), null],
  [
    JSON.stringify({ accessToken: REPLACEMENT_ACCESS, refreshToken: NEW_REFRESH, expiresAt: 1e15 }),
    REPLACEMENT_ACCESS,
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
  expect(h.release).toHaveBeenCalledTimes(token ? 2 : 1);
});

it('refreshes using the token re-read under the lock', async () => {
  const fake = setup();
  h.read.mockResolvedValueOnce(
    JSON.stringify({ accessToken: randomUUID(), refreshToken: SPENT_REFRESH, expiresAt: 0 }),
  );
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.refresh).toHaveBeenCalledWith(OLD_REFRESH);
  expect(h.release).toHaveBeenCalledTimes(2);
});

it.each(['key', 'write'])(
  'persists refreshed usage credentials despite lock-check failure during %s',
  async (phase) => {
    const fake = setup();
    seedGrant(fake);
    const lose = () => {
      h.release.assertHeld.mockRejectedValue(new Error('lock lost'));
    };
    if (phase === 'key')
      vi.spyOn(secretsService, 'getMasterKek').mockImplementationOnce(async () => {
        lose();
        return KEK;
      });
    else
      fake.hooks.beforeUpdate = async (table) => {
        if (table === schema.cliProviderSecrets) lose();
      };
    await runUsagePollTick(fake.db as unknown as Database);
    expect(h.refresh).toHaveBeenCalledOnce();
    const [stored] = fake.rows(schema.cliProviderSecrets);
    expect(stored!.encryptedValue).not.toBe(GRANT);
    expect(
      JSON.parse(
        envelopeDecrypt(
          {
            encryptedValue: stored!.encryptedValue as string,
            encryptedDek: stored!.encryptedDek as string,
          },
          KEK,
        ),
      ),
    ).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH });
  },
);

it('retries a rejected-refresh snapshot after losing the auth lock, respecting the throttle', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const fake = setup();
  let first = true;
  h.refresh.mockImplementation(async () => {
    if (first) {
      first = false;
      h.release.assertHeld.mockRejectedValue(new Error('lock lost'));
    }
    throw new ClaudeOauthError('refresh_token', 400, 'invalid_grant');
  });
  await runUsagePollTick(fake.db as unknown as Database);
  expect(fake.rows(schema.usageWindowSnapshots)).toHaveLength(0);
  h.release.assertHeld.mockResolvedValue(undefined);
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 190_000);
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.refresh).toHaveBeenCalledTimes(2);
  expect(fake.rows(schema.usageWindowSnapshots)).toMatchObject([{ status: 'needs_reconnect' }]);
  await runUsagePollTick(fake.db as unknown as Database);
  expect(h.refresh).toHaveBeenCalledTimes(2);
});
