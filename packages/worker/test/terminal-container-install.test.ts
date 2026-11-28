import { PassThrough } from 'node:stream';
import type Docker from 'dockerode';
import type { Database } from '@haive/database';
import { INSTALL_LABEL } from '@haive/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { GIT_MCP_IMAGE_LABEL, GIT_MCP_SERVER_VERSION } from '../src/sandbox/git-mcp-pin.js';
import { defaultDockerRunner } from '../src/sandbox/docker-runner.js';

vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveSandboxImageTag: vi.fn(async () => 'tib-sandbox:test'),
}));

import { resolveSandboxImageTag } from '../src/queues/cli-exec-queue.js';
import { ensureShellContainer } from '../src/terminal/terminal-container.js';

const USER = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROVIDER = 'bbbbbbbb-2222-4222-8222-222222222222';
const SCOPE = 'cccccccc-3333-4333-8333-333333333333';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

it.each([
  ['an image without the baked label', {}, false],
  ['an image with the baked label', { [GIT_MCP_IMAGE_LABEL]: GIT_MCP_SERVER_VERSION }, true],
])('writes the git MCP server for %s only when it is there', async (_label, labels, kept) => {
  vi.spyOn(defaultDockerRunner, 'inspect').mockResolvedValue({
    exists: true,
    imageId: 'sha256:x',
    labels,
  });
  const written: string[] = [];
  const container = {
    start: async () => undefined,
    exec: async () => ({
      start: async (opts: { stdin?: boolean }) => {
        const stream = new PassThrough();
        if (opts.stdin) stream.on('data', (c) => written.push(String(c)));
        else setImmediate(() => stream.end());
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
    createContainer: async () => container,
    getNetwork: () => ({ connect: async () => undefined }),
  } as unknown as Docker;
  const db = {
    query: {
      cliProviders: {
        findFirst: async () => ({
          id: PROVIDER,
          userId: USER,
          name: 'claude-code',
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
    scope: 'task',
    scopeId: SCOPE,
    providerId: PROVIDER,
    repoMount: null,
    mcpServers: [
      { name: 'git', command: 'git-server', args: [] },
      { name: 'other', command: 'other-server', args: [] },
    ],
  });
  const config = written.find((w) => w.includes('"mcpServers"'));
  expect(config, written.join('|')).toBeDefined();
  const servers = JSON.parse(config!).mcpServers as Record<string, unknown>;
  expect(Object.keys(servers).includes('git')).toBe(kept);
  expect(servers.other).toBeDefined();
});

it.each([
  ['1:999', true, SCOPE],
  ['', false, SCOPE],
  ['', false, '_scratch/task'],
])(
  'warm shell identity=%s recreates=%s while preserving auth volumes',
  async (mounted, recreate, subpath) => {
    vi.stubEnv('CONFIG_ENCRYPTION_KEY', '');
    const root = await import('node:fs/promises');
    const path = await import('node:path');
    const storage = await root.mkdtemp('/tmp/terminal-checkout-');
    vi.stubEnv('REPO_STORAGE_ROOT', storage);
    await root.mkdir(path.join(storage, USER, subpath), { recursive: true });
    const stop = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    let reads = 0;
    const absent = Object.assign(new Error('arbitrary text'), { statusCode: 404 });
    const container = {
      start: async () => {},
      stop,
      remove,
      inspect: async () => {
        if (++reads > 1) throw absent;
        return {
          State: { Running: true },
          Created: '2026-11-27T10:00:00Z',
          Config: { Labels: { 'haive.checkout.identity': mounted } },
        };
      },
      exec: async () => ({
        start: async (opts: { stdin?: boolean }) => {
          const stream = new PassThrough();
          if (!opts.stdin) setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ ExitCode: 0 }),
      }),
    };
    const create = vi.fn(async () => container);
    const docker = {
      getContainer: () => container,
      createContainer: create,
      getNetwork: () => ({ connect: async () => {} }),
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
    try {
      const result = await ensureShellContainer({
        db,
        docker,
        userId: USER,
        scope: 'repo',
        scopeId: SCOPE,
        providerId: PROVIDER,
        repoMount: {
          source: 'haive_repos',
          target: '/haive/workdir',
          subpath: `${USER}/${subpath}`,
        },
        mcpServers: [],
      });
      expect(result.created).toBe(recreate);
      expect(stop).toHaveBeenCalledTimes(recreate ? 1 : 0);
      expect(remove).toHaveBeenCalledTimes(recreate ? 1 : 0);
      if (!recreate) {
        expect(create).not.toHaveBeenCalled();
        return;
      }
      expect(remove).toHaveBeenCalledExactlyOnceWith({ force: false });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          Labels: expect.objectContaining({
            'haive.checkout.identity': expect.stringMatching(/^\d+:\d+$/),
          }),
        }),
      );
    } finally {
      await root.rm(storage, { recursive: true, force: true });
    }
  },
);
