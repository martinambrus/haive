const authLock = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn(async () => {}) }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: authLock.acquire,
}));
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Database } from '@haive/database';
import { refreshExpiringCliCredentials } from './credential-refresh.js';
import { readVolumeFile, writeVolumeFile } from './token-source.js';
import { listTaskAuthVolumes } from '../sandbox/auth-volume-reaper.js';

vi.mock('./token-source.js', () => ({ readVolumeFile: vi.fn(), writeVolumeFile: vi.fn() }));
vi.mock('../sandbox/auth-volume-reaper.js', () => ({ listTaskAuthVolumes: vi.fn() }));
import { taskVolumesHoldProvider } from './credential-refresh.js';

// The yield rule. A per-task auth volume existing for a CLI means a task holds a COPY of
// the same credential and may refresh off the same single-use refresh token; rotating the
// user volume at that moment signs one of the two out mid-run. Getting this wrong in the
// permissive direction breaks a running task, so the false answers are not symmetric.
describe('taskVolumesHoldProvider', () => {
  const TASK_GROK = 'haive_cli_auth_task_dd682d32fe60_grok_0';
  const TASK_CODEX = 'haive_cli_auth_task_c58cd9729db8_codex_0';
  const USER_GROK = 'haive_cli_auth_0a2cb56857b4_grok_0';
  const USER_GROK_APIKEY = 'haive_cli_auth_0a2cb56857b4_grok_k_0';
  const PROVIDER_GROK = 'haive_cli_auth_p_012c35842bb5_grok_0';

  it('holds when a per-task volume for that CLI exists', () => {
    expect(taskVolumesHoldProvider([TASK_CODEX, TASK_GROK], 'grok')).toBe(true);
  });

  it('does not hold when only other CLIs have task volumes', () => {
    expect(taskVolumesHoldProvider([TASK_CODEX], 'grok')).toBe(false);
  });

  it('does not hold on an empty host', () => {
    expect(taskVolumesHoldProvider([], 'grok')).toBe(false);
  });

  // The user and per-provider volumes are the things being rotated, not copies of it.
  // Treating them as a hold would mean never rotating at all.
  it('ignores user and per-provider volumes', () => {
    expect(taskVolumesHoldProvider([USER_GROK, USER_GROK_APIKEY, PROVIDER_GROK], 'grok')).toBe(
      false,
    );
  });

  it('matches a hyphenated CLI name', () => {
    expect(
      taskVolumesHoldProvider(['haive_cli_auth_task_c58cd9729db8_claude-code_1'], 'claude-code'),
    ).toBe(true);
  });
});

let user = 0;
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
  const db = {
    query: {
      cliProviders: { findMany: vi.fn(async () => [row, { ...row, id: 'shared-provider' }]) },
    },
    update,
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
  return { db, update, set, raw };
}

beforeEach(() => {
  vi.clearAllMocks();
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
      expect(writeVolumeFile).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }),
        })),
      );
      await refreshExpiringCliCredentials(db);
      expect(writeVolumeFile).toHaveBeenCalledTimes(1);
      expect(JSON.parse(vi.mocked(writeVolumeFile).mock.calls[0]![2])).toMatchObject({
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
      expect(writeVolumeFile).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => success),
      );
      await refreshExpiringCliCredentials(db);
      expect(writeVolumeFile).toHaveBeenCalledTimes(3);
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
    expect(writeVolumeFile).not.toHaveBeenCalled();
    vi.mocked(readVolumeFile).mockResolvedValue(raw('relogin-refresh'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'new-access' }) })),
    );
    await refreshExpiringCliCredentials(db);
    expect(writeVolumeFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(writeVolumeFile).mock.calls[0]![2])).toMatchObject({
      'issuer::client': { refresh_token: 'relogin-refresh' },
    });
  });

  it('yields without reading credentials when a task holds a copy', async () => {
    const { db } = refreshFixture();
    vi.mocked(listTaskAuthVolumes).mockResolvedValue(['haive_cli_auth_task_123_grok_0']);
    await refreshExpiringCliCredentials(db);
    expect(readVolumeFile).not.toHaveBeenCalled();
  });
});

it('yields credential refresh to sign-out/login without reading or spending a token', async () => {
  const { db, update } = refreshFixture();
  authLock.acquire.mockResolvedValueOnce(null);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await refreshExpiringCliCredentials(db);
  expect(readVolumeFile).not.toHaveBeenCalled();
  expect(writeVolumeFile).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
it('releases its auth lock when a credential read throws', async () => {
  const { db } = refreshFixture();
  vi.mocked(readVolumeFile).mockRejectedValueOnce(new Error('read failed'));
  await refreshExpiringCliCredentials(db);
  expect(authLock.release).toHaveBeenCalledOnce();
});
