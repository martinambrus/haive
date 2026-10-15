import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before the manager is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-terminal-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const USER = 'user-1';
const SUBPATH = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222';
const repoMount = { source: 'haive_repos', target: '/haive/workdir', subpath: SUBPATH };

const h = vi.hoisted(() => ({ ensure: vi.fn() }));
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
    redis: {} as never,
    subscriberRedis: {} as never,
    docker: {} as never,
    buildMcpServers: async () => [],
  });
  return mgr as unknown as { openSession: (req: unknown) => Promise<unknown> };
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
  h.ensure.mockReset().mockRejectedValue(new Error('shell container not started in this test'));
  await rm(path.join(storageRoot, SUBPATH), { recursive: true, force: true });
  for (const name of ['state', 'knowledge_base', 'learnings']) {
    await mkdir(path.join(storageRoot, SUBPATH, '.haive-data', name), { recursive: true });
  }
  await mkdir(path.join(storageRoot, SUBPATH, '.git'));
});

describe('the terminals are human surfaces', () => {
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
