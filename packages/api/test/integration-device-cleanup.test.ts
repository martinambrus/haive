import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { logger } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { HttpError } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { githubOauthRoutes } from '../src/routes/github-oauth.js';
import { integrationsRoutes } from '../src/routes/integrations.js';
import { finishSignIn, type SignInResult } from '../src/lib/integration-sign-in.js';
import { claimDevicePoll, dropDeviceRecord } from '../src/lib/integration-state.js';

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'user-1');
    await next();
  },
}));
vi.mock('../src/lib/integration-sign-in.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/integration-sign-in.js')>()),
  finishSignIn: vi.fn(),
}));
vi.mock('../src/lib/integration-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/integration-state.js')>()),
  claimDevicePoll: vi.fn(),
  dropDeviceRecord: vi.fn(),
}));
vi.mock('@haive/shared/integrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/integrations')>()),
  isProviderEnabled: async () => true,
  resolveOauthClient: async () => ({ clientId: 'client-1', clientSecret: null, source: 'admin' }),
  resolveOauthClientById: async () => null,
}));

const app = new Hono<AppEnv>();
app.route('/github-oauth', githubOauthRoutes);
app.route('/integrations', integrationsRoutes);
app.onError(errorHandler);

const result: SignInResult = {
  connection: {
    id: 'connection-1',
    providerId: 'github',
    accountLabel: 'octocat',
    authMethod: 'device',
    grantedScopes: ['repo'],
    status: 'connected',
    lastError: null,
    repoCredentialId: 'credential-1',
    expiresAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  credential: { id: 'credential-1', label: 'GitHub OAuth (octocat)', host: 'github.com' },
};

beforeEach(() => {
  vi.mocked(claimDevicePoll).mockResolvedValue({
    kind: 'claimed',
    record: { deviceCode: 'fake-device-code', interval: 5, clientId: 'client-1', scopes: ['repo'] },
  });
  vi.mocked(finishSignIn).mockResolvedValue(result);
  vi.mocked(dropDeviceRecord).mockRejectedValue(new TypeError('Redis unavailable'));
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  // Every vendor call stays in process; the real device-token parser reads this fake answer.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ access_token: 'fake-access' })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ['/github-oauth/poll', { deviceCode: 'handle-1' }, 'credential'],
  ['/integrations/providers/github/device/poll', { handle: 'handle-1' }, 'connection'],
] as const)('device cleanup through %s', (path, body, field) => {
  const poll = () =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('returns the committed sign-in when Redis cleanup fails, and warns without secrets', async () => {
    const res = await poll();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', [field]: { id: result[field]!.id } });
    expect(finishSignIn).toHaveBeenCalledTimes(1);
    expect(dropDeviceRecord).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { userId: 'user-1', providerId: 'github', errorName: 'TypeError' },
      'device sign-in cleanup failed',
    );
  });

  it('preserves the sign-in error when Redis cleanup also fails', async () => {
    vi.mocked(finishSignIn).mockRejectedValue(new HttpError(400, 'Sign-in refused'));
    const res = await poll();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Sign-in refused' });
    expect(dropDeviceRecord).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('still returns success when cleanup succeeds', async () => {
    vi.mocked(dropDeviceRecord).mockResolvedValue(undefined);
    const res = await poll();
    expect(res.status).toBe(200);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves a vendor refusal when cleanup also fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'access_denied' })),
    );
    const res = await poll();
    expect(res.status).toBe(400);
    expect(finishSignIn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('preserves a removed-client refusal when cleanup also fails', async () => {
    vi.mocked(claimDevicePoll).mockResolvedValue({
      kind: 'claimed',
      record: {
        deviceCode: 'fake-device-code',
        interval: 5,
        clientId: 'removed',
        scopes: ['repo'],
      },
    });
    const res = await poll();
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(finishSignIn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
