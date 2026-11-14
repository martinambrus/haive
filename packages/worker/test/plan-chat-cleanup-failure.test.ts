import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  cleanup: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('../src/plan/chat-snapshot.js', () => ({
  createPlanChatSnapshot: async () => ({ subpath: 'snapshot/plan.json', remove: mocks.remove }),
}));
vi.mock('../src/sandbox/egress-gateway.js', () => ({
  createEgressGateway: async () => ({
    networkName: 'test-net',
    proxyUrl: 'http://proxy',
    cleanup: mocks.cleanup,
  }),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  chown: vi.fn().mockResolvedValue(undefined),
  rm: mocks.rm.mockResolvedValue(undefined),
}));
vi.mock('@haive/shared', async (original) => {
  const shared = await original<typeof import('@haive/shared')>();
  return { ...shared, logger: { child: () => ({ error: mocks.error, warn: vi.fn() }) } };
});
import { runInSandbox } from '../src/sandbox/sandbox-runner.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

let root: string;
afterEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it.each(['success', 'failure', 'cancel'] as const)(
  'preserves %s and runs every cleanup if snapshot removal rejects',
  async (outcome) => {
    root = await mkdtemp(join(tmpdir(), 'snapshot-cleanup-'));
    const removalError = new Error('snapshot EIO');
    mocks.remove.mockRejectedValue(removalError);
    const runError = new Error('CLI failed');
    const result = { exitCode: 0, stdout: 'answer', stderr: '', durationMs: 0, timedOut: false };
    const run = vi.fn(async () => {
      if (outcome === 'failure') throw runError;
      return result;
    });
    const pending = runInSandbox(
      {
        command: 'cli',
        args: [],
        planSnapshot: {} as never,
        wrapperContent: '#!/bin/sh\nexec cli',
        extraFiles: [{ containerPath: '/haive/config', content: 'config' }],
        captureDir: { containerDir: '/haive/log', fileName: 'log' },
        ...(outcome === 'cancel' ? { beforeRun: async () => false } : {}),
      },
      {
        image: 'test-image',
        wrapperWorkerPath: root,
        docker: { run } as unknown as DockerRunner,
        networkPolicy: { mode: 'allowlist', domains: [], ips: [] },
      },
    );
    if (outcome === 'failure') await expect(pending).rejects.toBe(runError);
    else
      await expect(pending).resolves.toMatchObject(
        outcome === 'cancel' ? { exitCode: null } : result,
      );
    expect(mocks.rm).toHaveBeenCalledTimes(3);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: removalError }),
      expect.stringContaining('snapshot'),
    );
  },
);
