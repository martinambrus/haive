import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import type { Database } from '@haive/database';
import { INSTALL_LABEL } from '@haive/shared';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveSandboxImageTag: vi.fn(async () => 'tib-sandbox:test'),
}));

import { resolveSandboxImageTag } from '../src/queues/cli-exec-queue.js';
import { ensureShellContainer } from '../src/terminal/terminal-container.js';

const USER = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROVIDER = 'bbbbbbbb-2222-4222-8222-222222222222';
const SCOPE = 'cccccccc-3333-4333-8333-333333333333';

afterEach(() => vi.unstubAllEnvs());

it.each(['task', 'repo'] as const)('stamps the install on a new %s shell', async (scope) => {
  vi.stubEnv('HAIVE_INSTALL_ID', 'tib_second');
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
  const create = vi.fn(async (_opts: unknown) => container);
  const container = {
    start: async () => undefined,
    exec: async () => ({
      start: async (opts: { stdin?: boolean }) => {
        const stream = new PassThrough();
        if (!opts.stdin) setImmediate(() => stream.end());
        return stream;
      },
      inspect: async () => ({ ExitCode: 0 }),
    }),
    inspect: async () => {
      throw Object.assign(new Error('absent'), { statusCode: 404 });
    },
  };
  const docker = {
    getContainer: () => container,
    createContainer: create,
    getNetwork: () => ({ connect: async () => undefined }),
  } as unknown as Docker;
  const db = {
    query: {
      cliProviders: {
        findFirst: async () => ({
          id: PROVIDER,
          userId: USER,
          name: 'codex',
          enabled: true,
          authMode: 'subscription',
          isolateAuth: false,
        }),
      },
    },
  } as unknown as Database;

  await ensureShellContainer({
    db,
    docker,
    userId: USER,
    scope,
    scopeId: SCOPE,
    providerId: PROVIDER,
    repoMount: null,
    mcpServers: [],
  });

  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      Labels: expect.objectContaining({ [INSTALL_LABEL]: 'tib_second' }),
    }),
  );
});

it.each(['task', 'repo'] as const)(
  'refuses a disabled %s provider before image resolution or container reuse',
  async (scope) => {
    vi.mocked(resolveSandboxImageTag).mockClear();
    const getContainer = vi.fn();
    const db = {
      query: {
        cliProviders: {
          findFirst: async () => ({ id: PROVIDER, userId: USER, enabled: false }),
        },
      },
    } as unknown as Database;
    await expect(
      ensureShellContainer({
        db,
        docker: { getContainer } as unknown as Docker,
        userId: USER,
        scope,
        scopeId: SCOPE,
        providerId: PROVIDER,
        repoMount: null,
        mcpServers: [],
      }),
    ).rejects.toThrow('The CLI provider is disabled. Enable it before opening a terminal.');
    expect(resolveSandboxImageTag).not.toHaveBeenCalled();
    expect(getContainer).not.toHaveBeenCalled();
  },
);

it('checks provider ownership before disclosing that it is disabled', async () => {
  const db = {
    query: {
      cliProviders: {
        findFirst: async () => ({ id: PROVIDER, userId: 'another-user', enabled: false }),
      },
    },
  } as unknown as Database;
  await expect(
    ensureShellContainer({
      db,
      docker: {} as Docker,
      userId: USER,
      scope: 'task',
      scopeId: SCOPE,
      providerId: PROVIDER,
      repoMount: null,
      mcpServers: [],
    }),
  ).rejects.toThrow('cli provider does not belong to user');
});
