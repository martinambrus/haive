const authLock = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: Object.assign(
    vi.fn(async () => {}),
    { assertHeld: vi.fn(async () => {}) },
  ),
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
        if (bindings.module === 'credential-refresh') child.debug = authLock.debug;
        return child;
      },
    },
  };
});
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: authLock.acquire,
}));
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cliAuthTaskVolumeName, resolveCliAuthUserVolumeName } from '@haive/shared';
import type { DockerRunner } from '../sandbox/docker-runner.js';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import type { Database } from '@haive/database';
import { refreshExpiringCliCredentials } from './credential-refresh.js';
import { readVolumeFile, writeVolumeFile } from './token-source.js';
import { listTaskAuthVolumes } from '../sandbox/auth-volume-reaper.js';

const credentialWrites = () =>
  vi.mocked(writeVolumeFile).mock.calls.filter((call) => call[1] === 'auth.json');

vi.mock('./token-source.js', () => ({ readVolumeFile: vi.fn(), writeVolumeFile: vi.fn() }));
vi.mock('../sandbox/auth-volume-reaper.js', () => ({ listTaskAuthVolumes: vi.fn() }));
import { taskVolumesHoldProvider } from './credential-refresh.js';

// Unknown-source live copies conservatively hold their CLI. Known source labels
// scope that hold, and retained terminal copies are covered by the refresh controls below.
describe('taskVolumesHoldProvider', () => {
  const TASK_GROK = 'haive_cli_auth_task_dd682d32fe60_grok_0';
  const TASK_CODEX = 'haive_cli_auth_task_c58cd9729db8_codex_0';
  const USER_GROK = 'haive_cli_auth_0a2cb56857b4_grok_0';
  const USER_GROK_APIKEY = 'haive_cli_auth_0a2cb56857b4_grok_k_0';
  const PROVIDER_GROK = 'haive_cli_auth_p_012c35842bb5_grok_0';

  const holds = (names: string[], cli: 'grok' | 'claude-code' = 'grok') =>
    taskVolumesHoldProvider(names, cli, USER_GROK, refreshFixture().db, {} as DockerRunner);

  it('holds when a live per-task volume has an unknown source', async () => {
    expect(await holds([TASK_CODEX, TASK_GROK])).toBe(true);
  });

  it('does not hold when only other CLIs have task volumes', async () => {
    expect(await holds([TASK_CODEX])).toBe(false);
  });

  it('does not hold on an empty host', async () => {
    expect(await holds([])).toBe(false);
  });

  // The user and per-provider volumes are the things being rotated, not copies of it.
  // Treating them as a hold would mean never rotating at all.
  it('ignores user and per-provider volumes', async () => {
    expect(await holds([USER_GROK, USER_GROK_APIKEY, PROVIDER_GROK])).toBe(false);
  });

  it('matches a hyphenated CLI name', async () => {
    expect(await holds(['haive_cli_auth_task_dd682d32fe60_claude-code_1'], 'claude-code')).toBe(
      true,
    );
  });
});

let user = 0;
const taskId = 'dd682d32-fe60-4000-8000-000000000001';
function refreshFixture() {
  const row = {
    id: 'fixture-provider',
    userId: `fixture-user-${++user}`,
    name: 'grok',
    authMode: 'subscription',
    isolateAuth: false,
  };
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const lock = { for: vi.fn(async () => [{ id: 'fixture-provider' }, { id: 'shared-provider' }]) };
  const tx = {
    update,
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => lock }) }) }),
  };
  const db = {
    query: {
      cliProviders: { findMany: vi.fn(async () => [row, { ...row, id: 'shared-provider' }]) },
      tasks: { findMany: vi.fn(async () => [{ id: taskId, status: 'running' }]) },
      cliInvocations: { findFirst: vi.fn(async () => undefined) },
    },
    update,
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Database;
  const raw = (refreshToken: string) =>
    JSON.stringify({
      'issuer::client': {
        key: 'old-access',
        refresh_token: refreshToken,
        oidc_client_id: 'client',
        expires_at: '2020-01-01T00:00:00Z',
        identity: 'preserved',
      },
    });
  vi.mocked(readVolumeFile).mockResolvedValue(raw('old-refresh'));
  return { db, row, update, set, raw };
}

beforeEach(() => {
  vi.clearAllMocks();
  authLock.release.assertHeld.mockReset().mockResolvedValue(undefined);
  authLock.acquire.mockReset().mockResolvedValue(authLock.release);
  vi.mocked(listTaskAuthVolumes).mockResolvedValue([]);
  vi.mocked(writeVolumeFile).mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Grok refresh suppression and retry', () => {
  it.each([
    [400, 'invalid_grant in proxy prose'],
    [503, '{"error":"invalid_grant"}'],
    [400, '{"error":"temporarily_unavailable","error_description":"invalid_grant"}'],
  ])(
    'retries HTTP %i with body %s without mutating credentials or relogin status',
    async (status, body) => {
      const { db, update } = refreshFixture();
      const fetchMock = vi.fn(async () => ({ ok: false, status, text: async () => body }));
      vi.stubGlobal('fetch', fetchMock);
      await refreshExpiringCliCredentials(db);
      await refreshExpiringCliCredentials(db);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(credentialWrites()).toHaveLength(0);
      expect(update).not.toHaveBeenCalled();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }),
        })),
      );
      await refreshExpiringCliCredentials(db);
      expect(credentialWrites()).toHaveLength(1);
      expect(JSON.parse(credentialWrites()[0]![2])).toMatchObject({
        'issuer::client': {
          key: 'new-access',
          refresh_token: 'new-refresh',
          identity: 'preserved',
        },
      });
    },
  );

  it.each(['request', 'body'])(
    'continues to the next user after a %s timeout and retries next tick',
    async (phase) => {
      const { db, update } = refreshFixture();
      const rows = await db.query.cliProviders.findMany();
      vi.mocked(db.query.cliProviders.findMany).mockResolvedValue([
        ...rows,
        { ...rows[0], userId: 'other-user' },
      ] as never);
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Grok deadline', 'TimeoutError')), ms);
        return controller.signal;
      });
      const success = {
        ok: true,
        json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }),
      };
      let first = true;
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (!first) return success;
        first = false;
        const signal = init?.signal;
        if (!signal) throw new Error('missing deadline signal');
        const stalled = () =>
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        return phase === 'request' ? stalled() : { ok: true, json: stalled };
      });
      // The first volume stalls; the next must still succeed in this sweep.
      vi.stubGlobal('fetch', fetchMock);
      const pending = refreshExpiringCliCredentials(db);
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(credentialWrites()).toHaveLength(1);
      expect(update).not.toHaveBeenCalled();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => success),
      );
      await refreshExpiringCliCredentials(db);
      expect(credentialWrites()).toHaveLength(3);
    },
  );

  it('suppresses only the rejected volume token, and retries after a re-login', async () => {
    const { db, set, raw } = refreshFixture();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await refreshExpiringCliCredentials(db);
    await refreshExpiringCliCredentials(db);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ authStatus: 'unknown' }));
    expect(credentialWrites()).toHaveLength(0);
    vi.mocked(readVolumeFile).mockResolvedValue(raw('relogin-refresh'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'new-access' }) })),
    );
    await refreshExpiringCliCredentials(db);
    expect(credentialWrites()).toHaveLength(1);
    expect(JSON.parse(credentialWrites()[0]![2])).toMatchObject({
      'issuer::client': { refresh_token: 'relogin-refresh' },
    });
  });

  it('yields without reading credentials when a task holds a copy', async () => {
    const { db } = refreshFixture();
    vi.mocked(listTaskAuthVolumes).mockResolvedValue([cliAuthTaskVolumeName(taskId, 'grok', 0)]);
    await refreshExpiringCliCredentials(db, {} as DockerRunner);
    expect(readVolumeFile).not.toHaveBeenCalled();
  });
});

it('yields credential refresh to sign-out/login without reading or spending a token', async () => {
  const { db, update } = refreshFixture();
  authLock.acquire.mockResolvedValueOnce(null);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await refreshExpiringCliCredentials(db);
  const rows = await db.query.cliProviders.findMany();
  expect(authLock.acquire).toHaveBeenCalledWith(db, cliAuthScope(rows[0]!));
  expect(readVolumeFile).not.toHaveBeenCalled();
  expect(credentialWrites()).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(authLock.debug).toHaveBeenCalledWith({ providerId: rows[0]!.id }, expect.any(String));
});
it('releases its auth lock when a credential read throws', async () => {
  const { db } = refreshFixture();
  vi.mocked(readVolumeFile).mockRejectedValueOnce(new Error('read failed'));
  await refreshExpiringCliCredentials(db);
  expect(authLock.release).toHaveBeenCalledOnce();
});

it('retries a rejected Grok refresh status after losing the auth lock', async () => {
  const { db, update } = refreshFixture();
  let first = true;
  const fetchMock = vi.fn(async () => {
    if (first) {
      first = false;
      authLock.release.assertHeld.mockRejectedValue(new Error('lock lost'));
    }
    return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
  });
  vi.stubGlobal('fetch', fetchMock);
  await refreshExpiringCliCredentials(db);
  expect(update).not.toHaveBeenCalled();
  authLock.release.assertHeld.mockResolvedValue(undefined);
  await refreshExpiringCliCredentials(db);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledOnce();
  await refreshExpiringCliCredentials(db);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

describe('task credential copy refresh holds', () => {
  function fixture() {
    const f = refreshFixture();
    vi.mocked(readVolumeFile).mockResolvedValue(f.raw(randomBytes(16).toString('hex')));
    const userVolume = resolveCliAuthUserVolumeName(
      {
        userId: f.row.userId,
        providerId: f.row.id,
        providerName: 'grok',
        authMode: 'subscription',
        isolateAuth: false,
      },
      0,
    );
    const source = (userVolume: string, isolateAuth = false) =>
      JSON.stringify({
        version: 1,
        userVolume,
        authMode: 'subscription',
        isolateAuth,
      });
    const volumeLabel = vi.fn(async () => source(userVolume));
    const runner = { volumeLabel } as unknown as DockerRunner;
    vi.mocked(listTaskAuthVolumes).mockResolvedValue([cliAuthTaskVolumeName(taskId, 'grok', 0)]);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: randomBytes(16).toString('hex'),
        refresh_token: randomBytes(16).toString('hex'),
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return { ...f, userVolume, source, volumeLabel, runner, fetchMock };
  }

  it.each(['completed', 'failed', 'cancelled'])(
    'refreshes beside a retained %s task copy',
    async (status) => {
      const f = fixture();
      vi.mocked(f.db.query.tasks.findMany).mockResolvedValue([{ id: taskId, status }] as never);
      // Recovery copies include unlabeled ones; label failures cannot make a settled copy live.
      f.volumeLabel.mockRejectedValue(new Error('label unavailable'));
      await refreshExpiringCliCredentials(f.db, f.runner);
      expect(f.fetchMock).toHaveBeenCalledOnce();
      expect(credentialWrites()).toHaveLength(1);
      expect(f.volumeLabel).not.toHaveBeenCalled();
    },
  );

  it.each(['running', 'waiting_form', 'queued', 'created'])(
    'holds a %s task copy of this credential',
    async (status) => {
      const f = fixture();
      vi.mocked(f.db.query.tasks.findMany).mockResolvedValue([{ id: taskId, status }] as never);
      await refreshExpiringCliCredentials(f.db, f.runner);
      expect(readVolumeFile).not.toHaveBeenCalled();
      expect(f.fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['another-user', 'isolated-provider'])(
    'does not hold another scope: %s',
    async (scope) => {
      const f = fixture();
      const other = resolveCliAuthUserVolumeName(
        {
          userId: scope === 'another-user' ? 'other-user' : f.row.userId,
          providerId: 'other-provider',
          providerName: 'grok',
          authMode: 'subscription',
          isolateAuth: scope === 'isolated-provider',
        },
        0,
      );
      f.volumeLabel.mockResolvedValue(f.source(other, scope === 'isolated-provider'));
      await refreshExpiringCliCredentials(f.db, f.runner);
      expect(f.fetchMock).toHaveBeenCalledOnce();
      expect(credentialWrites()).toHaveLength(1);
    },
  );

  it('holds a terminal task while its invocation is still running', async () => {
    const f = fixture();
    vi.mocked(f.db.query.tasks.findMany).mockResolvedValue([
      { id: taskId, status: 'failed' },
    ] as never);
    vi.mocked(f.db.query.cliInvocations.findFirst).mockResolvedValue({
      id: 'live-invocation',
    } as never);
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(readVolumeFile).not.toHaveBeenCalled();
  });

  it('holds a slug collision when any matching task is live', async () => {
    const f = fixture();
    vi.mocked(f.db.query.tasks.findMany).mockResolvedValue([
      { id: taskId, status: 'completed' },
      { id: taskId.slice(0, -1) + '2', status: 'running' },
    ] as never);
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(readVolumeFile).not.toHaveBeenCalled();
  });

  it('does not broaden a known source hold when status lookup fails', async () => {
    const f = fixture();
    vi.mocked(f.db.query.tasks.findMany).mockRejectedValue(new Error('db unavailable'));
    f.volumeLabel.mockResolvedValue(
      f.source(
        resolveCliAuthUserVolumeName(
          {
            userId: 'other-user',
            providerId: 'other-provider',
            providerName: 'grok',
            authMode: 'subscription',
            isolateAuth: false,
          },
          0,
        ),
      ),
    );
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it('refreshes after the task row has been deleted', async () => {
    const f = fixture();
    vi.mocked(f.db.query.tasks.findMany).mockResolvedValue([]);
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it('refreshes a live copy with no credential source', async () => {
    const f = fixture();
    f.volumeLabel.mockResolvedValue('none');
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it.each([null, '{', '{}', '{"version":2,"userVolume":"other"}'])(
    'holds a live unknown source %s',
    async (label) => {
      const f = fixture();
      f.volumeLabel.mockResolvedValue(label as never);
      await refreshExpiringCliCredentials(f.db, f.runner);
      expect(readVolumeFile).not.toHaveBeenCalled();
    },
  );

  it('retries a failed source lookup on the next tick', async () => {
    const f = fixture();
    f.volumeLabel.mockRejectedValueOnce(new Error('Docker unavailable')).mockResolvedValue('none');
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(readVolumeFile).not.toHaveBeenCalled();
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it('scopes a known v0 label despite key order and extra fields', async () => {
    const f = fixture();
    f.volumeLabel.mockResolvedValue(
      JSON.stringify({
        isolateAuth: false,
        extra: 'ignored',
        authMode: 'subscription',
        userVolume: resolveCliAuthUserVolumeName(
          {
            userId: 'other-user',
            providerId: 'other-provider',
            providerName: 'grok',
            authMode: 'subscription',
            isolateAuth: false,
          },
          0,
        ),
      }),
    );
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });

  it('holds only the matching user volume in a multi-user refresh tick', async () => {
    const f = fixture();
    vi.mocked(f.db.query.cliProviders.findMany).mockResolvedValue([
      f.row,
      { ...f.row, id: 'other-provider', userId: 'other-user' },
    ] as never);
    await refreshExpiringCliCredentials(f.db, f.runner);
    expect(f.fetchMock).toHaveBeenCalledOnce();
    // Both the credential and its uncertainty fence belong to the unheld scope.
    expect(vi.mocked(readVolumeFile).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(readVolumeFile).mock.calls.every(([volume]) => volume !== f.userVolume)).toBe(
      true,
    );
  });

  it.each(['tasks', 'cliInvocations'])(
    'holds a failed %s lookup only until the next successful tick',
    async (table) => {
      const f = fixture();
      vi.mocked(f.db.query.tasks.findMany).mockResolvedValue([
        { id: taskId, status: 'failed' },
      ] as never);
      if (table === 'tasks')
        vi.mocked(f.db.query.tasks.findMany).mockRejectedValueOnce(new Error('db unavailable'));
      else
        vi.mocked(f.db.query.cliInvocations.findFirst).mockRejectedValueOnce(
          new Error('db unavailable'),
        );
      await refreshExpiringCliCredentials(f.db, f.runner);
      expect(readVolumeFile).not.toHaveBeenCalled();
      await refreshExpiringCliCredentials(f.db, f.runner);
      expect(f.fetchMock).toHaveBeenCalledOnce();
      expect(credentialWrites()).toHaveLength(1);
    },
  );
});
