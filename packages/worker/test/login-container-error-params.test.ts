import { randomBytes } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  tryCliAuthLock: h.acquire,
}));
beforeEach(() => {
  vi.clearAllMocks();
  h.acquire.mockResolvedValue(h.release);
  h.run.mockResolvedValue({ exitCode: 0 });
  h.create.mockResolvedValue({ containerRowId: 'row', dockerContainerId: 'container' });
});
vi.mock('../src/sandbox/login-container.js', () => ({ createSandboxLoginContainer: h.create }));
vi.mock('../src/sandbox/docker-runner.js', () => ({
  defaultDockerRunner: { run: h.run },
}));
vi.mock('../src/cli-adapters/registry.js', () => ({
  cliAdapterRegistry: { has: () => true, get: () => ({ defaultExecutable: 'claude' }) },
}));
vi.mock('../src/cli-adapters/setup-token-command.js', () => ({
  buildSetupTokenCommand: () => ({ executable: 'claude', args: [] }),
}));

import { logger } from '@haive/shared';
import { handleLoginCreateJob } from '../src/queues/cli-exec/handlers.js';

afterEach(() => vi.restoreAllMocks());

it('returns a safe failure when the container insert binds environment secrets', async () => {
  const secret = randomBytes(24).toString('base64url');
  h.create.mockRejectedValueOnce(
    new DrizzleQueryError(
      'insert into containers (env_vars) values ($1)',
      [secret],
      new Error(secret),
    ),
  );
  const db = {
    query: {
      cliProviders: {
        findFirst: async () => ({ id: 'provider', userId: 'user', name: 'claude-code' }),
      },
    },
  };
  // The shared serializer itself is exercised with the real DB control; do not print a fixture here.
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const result = await handleLoginCreateJob(db as never, {
    providerId: 'provider',
    userId: 'user',
  });
  expect(result.ok).toBe(false);
  const text = JSON.stringify(result);
  expect(
    Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((part) =>
      text.includes(part),
    ),
  ).toBe(false);
  expect(h.create).toHaveBeenCalledOnce();
});

const provider = () => ({
  id: 'provider',
  userId: 'user',
  name: 'claude-code',
  authMode: 'subscription',
  isolateAuth: false,
});
const makeDb = (row = provider()) => ({
  query: { cliProviders: { findFirst: vi.fn(async () => ({ ...row })) } },
});
const payload = { providerId: 'provider', userId: 'user' };
it('holds the auth scope throughout ownership helpers and login container creation', async () => {
  h.run.mockImplementation(async () => {
    expect(h.acquire).toHaveBeenCalledWith(expect.anything(), 'haive_cli_auth_user_claude-code_0');
    expect(h.release).not.toHaveBeenCalled();
    return { exitCode: 0 };
  });
  h.create.mockImplementationOnce(async () => {
    expect(h.release).not.toHaveBeenCalled();
    return { containerRowId: 'row', dockerContainerId: 'container' };
  });
  expect(await handleLoginCreateJob(makeDb() as never, payload)).toMatchObject({ ok: true });
  expect(h.run).toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it('mounts nothing while sign-out owns the auth scope', async () => {
  h.acquire.mockResolvedValueOnce(null);
  expect(await handleLoginCreateJob(makeDb() as never, payload)).toMatchObject({ ok: false });
  expect(h.run).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
});
it('refuses a moved scope before mounting any ownership helper', async () => {
  const row = provider();
  h.acquire.mockImplementationOnce(async () => {
    row.isolateAuth = true;
    return h.release;
  });
  expect(await handleLoginCreateJob(makeDb(row) as never, payload)).toMatchObject({ ok: false });
  expect(h.run).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
});
it('releases the scope even when login container creation fails', async () => {
  h.create.mockRejectedValueOnce(new Error('create failed'));
  expect(await handleLoginCreateJob(makeDb() as never, payload)).toMatchObject({ ok: false });
  expect(h.release).toHaveBeenCalledOnce();
});
