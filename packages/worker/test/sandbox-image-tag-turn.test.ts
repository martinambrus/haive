import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const P1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const TAG = 'haive-cli-sandbox:claude-code-1.0.0-0123456789abcdef';

const docker = vi.hoisted(() => ({
  inspect: vi.fn(),
  build: vi.fn(),
  remove: vi.fn(),
}));
const marked = vi.hoisted(() => ({ calls: [] as string[] }));
const turns = vi.hoisted(() => [] as string[]);

vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/docker-runner.js')>();
  return { ...actual, defaultDockerRunner: { ...actual.defaultDockerRunner, ...docker } };
});
vi.mock('../src/sandbox/image-cache.js', () => ({
  resolveImageTag: () => ({
    tag: 'haive-cli-sandbox:claude-code-1.0.0-0123456789abcdef',
    shared: true,
    dockerfileLines: [],
  }),
  renderDockerfile: () => 'FROM haive-cli-sandbox:latest\n',
}));
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({
  ensureSandboxCoreImage: async () => {},
  SANDBOX_CORE_IMAGE_HEADLINE: 'x',
}));
vi.mock('../src/queues/cli-exec/images.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/cli-exec/images.js')>();
  return {
    ...actual,
    withImageTagLock: <T>(tag: string, fn: () => Promise<T>) => {
      turns.push(tag);
      return actual.withImageTagLock(tag, fn);
    },
    markProvidersReady: async (_db: unknown, _tag: string, providerId: string) => {
      marked.calls.push(providerId);
      return { self: true, replaced: [] as string[] };
    },
  };
});

import {
  handleBuildSandboxImageJob,
  handleRemoveSandboxImageJob,
} from '../src/queues/cli-exec/handlers.js';

function db(): Database {
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  fake.insert(schema.cliProviders, { id: P1, name: 'claude-code', sandboxImageTag: null });
  return fake.db as unknown as Database;
}

let imageExists: boolean;

beforeEach(() => {
  marked.calls.length = 0;
  turns.length = 0;
  imageExists = true;
  docker.inspect.mockReset();
  docker.build.mockReset();
  docker.remove.mockReset();
  docker.inspect.mockImplementation(async () => ({
    exists: imageExists,
    imageId: imageExists ? 'sha256:old' : null,
  }));
  docker.build.mockImplementation(async () => {
    imageExists = true;
    return { exitCode: 0, imageTag: TAG, imageId: 'sha256:old', durationMs: 1, stderr: '' };
  });
  docker.remove.mockImplementation(async () => {
    imageExists = false;
    return { ok: true, stderr: '' };
  });
});

describe('a build and a removal of one tag', () => {
  it('never interleave: a fully cached build started inside the removal keeps its image', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const removalPaused = new Promise<void>((resolve) => (entered = resolve));
    let pauses = 1;
    docker.inspect.mockImplementation(async () => {
      const state = { exists: imageExists, imageId: imageExists ? 'sha256:old' : null };
      if (pauses-- > 0) {
        entered();
        await gate;
      }
      return state;
    });

    const database = db();
    const removing = handleRemoveSandboxImageJob(database, { providerId: 'gone', imageTag: TAG });
    await removalPaused;
    const building = handleBuildSandboxImageJob(database, {
      providerId: P1,
      userId: 'u',
      force: true,
    });
    // The build either reaches docker or queues for the tag's turn behind the removal.
    await vi.waitFor(() =>
      expect(docker.build.mock.calls.length + turns.length).toBeGreaterThan(0),
    );
    release();
    const [, built] = await Promise.all([removing, building]);

    expect(built).not.toHaveProperty('error');
    expect(built).toMatchObject({ ok: true, imageTag: TAG });
    expect(imageExists).toBe(true);
    expect(marked.calls).toEqual([P1]);
  });

  it('a removal with no build still removes the image', async () => {
    await handleRemoveSandboxImageJob(db(), { providerId: 'gone', imageTag: TAG });
    expect(docker.remove).toHaveBeenCalledWith(TAG);
    expect(imageExists).toBe(false);
  });

  it('a build with no removal still claims its image', async () => {
    const built = await handleBuildSandboxImageJob(db(), {
      providerId: P1,
      userId: 'u',
      force: true,
    });
    expect(built).toMatchObject({ ok: true, imageTag: TAG });
    expect(marked.calls).toEqual([P1]);
    expect(docker.remove).not.toHaveBeenCalled();
  });
});
