import { beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({
  probe: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  write: vi.fn(),
}));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
vi.mock('../src/queues/cli-exec/images.js', () => ({ probeCliPath: h.probe }));
vi.mock('../src/secrets/provider-secrets.js', () => ({ resolveProviderSecrets: async () => ({}) }));
import { handleProbeJob } from '../src/queues/cli-exec/handlers.js';

let provider: any;
let db: Database;
beforeEach(() => {
  vi.clearAllMocks();
  provider = {
    id: 'provider',
    userId: 'user',
    name: 'gemini',
    authMode: 'subscription',
    isolateAuth: false,
    authGeneration: 'login',
    authLastCheckedAt: null,
  };
  h.acquire.mockResolvedValue(h.release);
  h.probe.mockResolvedValue({ ok: true, authStatus: 'ok' });
  db = {
    query: { cliProviders: { findFirst: async () => ({ ...provider }) } },
    update: () => ({ set: (values: unknown) => ({ where: async () => h.write(values) }) }),
  } as unknown as Database;
});
const probe = () =>
  handleProbeJob(db, { providerId: 'provider', userId: 'user', targetMode: 'cli' });

it('publishes unchanged active health under the matching scope lock', async () => {
  h.write.mockImplementationOnce(() => expect(h.release).not.toHaveBeenCalled());
  await probe();
  expect(h.acquire).toHaveBeenCalledWith(db, 'haive_cli_auth_user_gemini_0');
  expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ authStatus: 'ok' }));
  expect(h.release).toHaveBeenCalledOnce();
});
it('keeps sign-out outside the credential-read and health-write interval', async () => {
  let held = false;
  h.acquire.mockImplementation(async () => {
    if (held) return null;
    held = true;
    return h.release;
  });
  h.probe.mockImplementationOnce(async () => {
    const { handleSignOutJob } = await import('../src/queues/cli-exec/handlers.js');
    await expect(
      handleSignOutJob(db, { providerId: 'provider', userId: 'user' }, {
        volumeExists: vi.fn(),
      } as any),
    ).rejects.toThrow('CLI authentication is busy');
    expect(h.release).not.toHaveBeenCalled();
    return { ok: true, authStatus: 'ok' };
  });
  await probe();
  expect(h.write).toHaveBeenCalledOnce();
  expect(h.release).toHaveBeenCalledOnce();
});
it('uses a sign-out reset that landed before acquisition, not the old provider snapshot', async () => {
  h.acquire.mockImplementationOnce(async () => {
    provider = { ...provider, authStatus: 'unknown', authGeneration: 'new-login' };
    return h.release;
  });
  await probe();
  expect(h.probe.mock.calls[0]?.[2]).toMatchObject({
    authStatus: 'unknown',
    authGeneration: 'new-login',
  });
});
it('refuses a scope that moved before acquisition without probing or writing', async () => {
  h.acquire.mockImplementationOnce(async () => {
    provider.isolateAuth = true;
    return h.release;
  });
  await probe();
  expect(h.probe).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it('skips publication while another credential writer owns the scope', async () => {
  h.acquire.mockResolvedValueOnce(null);
  await probe();
  expect(h.probe).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.release).not.toHaveBeenCalled();
});
it('releases the publication lock on a failed health write', async () => {
  h.write.mockRejectedValueOnce(new Error('write refused'));
  await expect(probe()).rejects.toThrow('write refused');
  expect(h.release).toHaveBeenCalledOnce();
});
