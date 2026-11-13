import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TERMINAL_REQUEST_CHANNEL, TERMINAL_REPLY_CHANNEL_PREFIX } from '@haive/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before the manager is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-terminal-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const USER = 'user-1';
const SUBPATH = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222';
const repoMount = { source: 'haive_repos', target: '/haive/workdir', subpath: SUBPATH };

const h = vi.hoisted(() => ({ ensure: vi.fn(), publish: vi.fn(), error: null as Error | null }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (...args: Parameters<typeof real.lstat>) => {
      if (h.error && String(args[0]).endsWith('/.git')) throw h.error;
      return real.lstat(...args);
    },
  };
});

afterEach(() => {
  h.error = null;
});

vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveRepoMount: vi.fn(async () => repoMount),
  resolveTaskRepoMount: vi.fn(async () => repoMount),
  resolveTaskSandboxWorkdir: vi.fn(async () => '/haive/workdir'),
}));
vi.mock('../src/terminal/terminal-container.js', () => ({
  ensureShellContainer: h.ensure,
  seedShellTrust: vi.fn(async () => undefined),
}));

const { TerminalSessionManager } = await import('../src/terminal/terminal-session-manager.js');

function manager() {
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 'task-1',
          userId: USER,
          status: 'running',
          type: 'onboarding',
          repositoryId: 'repo-1',
        }),
      },
      taskSteps: { findFirst: async () => ({ status: 'done' }) },
      cliProviders: { findFirst: async () => undefined },
    },
  };
  const mgr = new TerminalSessionManager({
    db: db as never,
    redis: { publish: h.publish } as never,
    subscriberRedis: {} as never,
    docker: {} as never,
    buildMcpServers: async () => [],
  });
  return mgr as unknown as {
    started: boolean;
    openSession: (req: unknown) => Promise<unknown>;
    handleSubscriberMessage: (channel: string, raw: string) => Promise<void>;
  };
}

const open = (scope: 'task' | 'repo') =>
  manager().openSession({
    op: 'open',
    correlationId: 'c1',
    userId: USER,
    cliProviderId: 'prov-1',
    scope,
    ...(scope === 'task' ? { taskId: 'task-1' } : { repositoryId: 'repo-1' }),
  });

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  h.publish.mockReset().mockResolvedValue(1);
  h.ensure.mockReset().mockRejectedValue(new Error('shell container not started in this test'));
  await rm(path.join(storageRoot, SUBPATH), { recursive: true, force: true });
  for (const name of ['state', 'knowledge_base', 'learnings']) {
    await mkdir(path.join(storageRoot, SUBPATH, '.haive-data', name), { recursive: true });
  }
  await mkdir(path.join(storageRoot, SUBPATH, '.git'));
});

describe('the terminals are human surfaces', () => {
  it.each(['EMFILE', 'ENFILE', 'EACCES', 'EIO'])(
    'answers a normal terminal error without starting a container on %s, then allows retry',
    async (code) => {
      const mgr = manager();
      mgr.started = true;
      const request = JSON.stringify({
        op: 'open',
        correlationId: 'c1',
        userId: USER,
        cliProviderId: 'prov-1',
        scope: 'task',
        taskId: 'task-1',
      });
      h.error = Object.assign(
        new Error(`${code}: lookup failed, lstat '${storageRoot}/${SUBPATH}'`),
        { code },
      );
      await mgr.handleSubscriberMessage(TERMINAL_REQUEST_CHANNEL, request);
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.publish).toHaveBeenLastCalledWith(
        `${TERMINAL_REPLY_CHANNEL_PREFIX}c1`,
        JSON.stringify({ ok: false, error: `${code}: lookup failed, lstat '[path]'` }),
      );

      h.error = null;
      await mgr.handleSubscriberMessage(TERMINAL_REQUEST_CHANNEL, request);
      expect(h.ensure).toHaveBeenCalledTimes(1);
      expect(h.ensure.mock.calls[0]![0].nestedMounts).toContainEqual({
        source: 'haive_repos',
        target: '/haive/workdir/.git',
        subpath: `${SUBPATH}/.git`,
        readOnly: true,
      });
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])('starts a task shell without a .git mount on %s', async (code) => {
    h.error = Object.assign(new Error('injected absent lookup'), { code });
    await expect(open('task')).rejects.toThrow('not started in this test');
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.calls[0]![0].nestedMounts).toEqual([]);
  });

  it('gives the task shell the read-only .git it always had, and no .haive-data mount', async () => {
    await expect(open('task')).rejects.toThrow('not started in this test');

    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.calls[0]![0].nestedMounts).toEqual([
      {
        source: 'haive_repos',
        target: '/haive/workdir/.git',
        subpath: `${SUBPATH}/.git`,
        readOnly: true,
      },
    ]);
  });

  it('gives the repository shell no nested mount at all', async () => {
    await expect(open('repo')).rejects.toThrow('not started in this test');

    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.calls[0]![0].nestedMounts).toEqual([]);
  });
});
