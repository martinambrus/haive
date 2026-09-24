import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const docker = vi.hoisted(() => ({
  inspect: vi.fn(),
  build: vi.fn(),
  remove: vi.fn(),
}));
const images = vi.hoisted(() => ({
  markProvidersReady: vi.fn(async () => {}),
  removeOrphanedPreviousImage: vi.fn(async () => ({ removed: false, reason: 'no-previous' })),
  probeCliPath: vi.fn(),
}));

vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/docker-runner.js')>();
  return { ...actual, defaultDockerRunner: { ...actual.defaultDockerRunner, ...docker } };
});
vi.mock('../src/sandbox/image-cache.js', () => ({
  resolveImageTag: () => ({ tag: 'haive-cli-claude:1.0.0', shared: true, dockerfileLines: [] }),
  renderDockerfile: () => 'FROM haive-cli-sandbox:latest\n',
}));
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({
  ensureSandboxCoreImage: async () => {},
  SANDBOX_CORE_IMAGE_HEADLINE: 'x',
}));
vi.mock('../src/queues/cli-exec/images.js', () => images);

import { handleBuildSandboxImageJob } from '../src/queues/cli-exec/handlers.js';

/** Two claude-family providers resolving to one shared tag. */
function fakeDb(): Database {
  const providers: Record<string, object> = {
    p1: { id: 'p1', name: 'claude-code', cliVersion: '1.0.0', sandboxImageTag: null },
    p2: { id: 'p2', name: 'zai', cliVersion: '1.0.0', sandboxImageTag: null },
  };
  let asked = 0;
  return {
    query: {
      cliProviders: {
        findFirst: async () => providers[asked++ % 2 === 0 ? 'p1' : 'p2'],
      },
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
  } as unknown as Database;
}

beforeEach(() => {
  for (const f of [...Object.values(docker), ...Object.values(images)]) f.mockClear();
  docker.inspect.mockResolvedValue({ exists: true, imageId: 'sha256:old' });
  docker.remove.mockResolvedValue({ ok: true, stderr: '' });
});

describe('sandbox image builds', () => {
  it('build a tag once when two providers need it at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docker.build.mockImplementation(async () => {
      await gate;
      return {
        exitCode: 0,
        imageTag: 'haive-cli-claude:1.0.0',
        imageId: 'sha256:new',
        durationMs: 1,
        stderr: '',
        timedOut: false,
      };
    });
    const db = fakeDb();
    const first = handleBuildSandboxImageJob(db, { providerId: 'p1', userId: 'u', force: true });
    const second = handleBuildSandboxImageJob(db, { providerId: 'p2', userId: 'u', force: true });
    await vi.waitFor(() => expect(docker.build).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    const results = await Promise.all([first, second]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(docker.remove).toHaveBeenCalledTimes(1);
    expect(images.markProvidersReady).toHaveBeenCalledTimes(2);
  });

  it('build again for a request that comes after the first build settled', async () => {
    docker.build.mockResolvedValue({
      exitCode: 0,
      imageTag: 'haive-cli-claude:1.0.0',
      imageId: 'sha256:new',
      durationMs: 1,
      stderr: '',
      timedOut: false,
    });
    const db = fakeDb();
    await handleBuildSandboxImageJob(db, { providerId: 'p1', userId: 'u', force: true });
    await handleBuildSandboxImageJob(db, { providerId: 'p2', userId: 'u', force: true });
    expect(docker.build).toHaveBeenCalledTimes(2);
  });
});
