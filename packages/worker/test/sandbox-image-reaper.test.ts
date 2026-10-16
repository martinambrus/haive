import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const log = vi.hoisted(() => {
  const spy = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => spy,
  };
  return spy;
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: log,
}));

import { withImageTagLock } from '../src/queues/cli-exec/images.js';
import {
  reapOrphanedSandboxImages,
  reapSupersededSandboxCores,
} from '../src/sandbox/sandbox-image-reaper.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

const REPO = 'haive-cli-sandbox';
const ORPHAN = `${REPO}:provider-aaaaaaaa-1111-4111-8111-111111111111-0123456789abcdef`;
const ORPHAN_SHARED = `${REPO}:codex-1.2.3-fedcba9876543210`;
const NAMED = `${REPO}:claude-code-1.0.0-0123456789abcdef`;
const BUILDING = `${REPO}:gemini-2.0.0-aaaaaaaaaaaaaaaa`;
const IN_USE = `${REPO}:zai-1.0.0-bbbbbbbbbbbbbbbb`;
const BASE = `${REPO}:latest`;
const COMPOSED = 'haive-sandbox:0123456789abcdef0123';
const PROVIDER = 'cccccccc-2222-4222-8222-222222222222';
const OTHER = 'dddddddd-3333-4333-8333-333333333333';

function setup(opts: { listed: string[] }) {
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  fake.insert(schema.cliProviders, { id: PROVIDER, name: 'claude-code', sandboxImageTag: NAMED });
  const removeCalls: string[] = [];
  const gone = new Set<string>();
  const runner = {
    inspect: async (tag: string) => ({ exists: !gone.has(tag), imageId: 'sha256:x' }),
    remove: async (ref: string) => {
      removeCalls.push(ref);
      if (ref === IN_USE) return { ok: false, stderr: 'image is being used by a container' };
      gone.add(ref);
      return { ok: true, stderr: '' };
    },
  } as unknown as DockerRunner;
  return {
    db: fake.db as unknown as Database,
    fake,
    removeCalls,
    deps: { listImageRefs: async () => opts.listed, runner },
  };
}

const ALL = [ORPHAN, ORPHAN_SHARED, NAMED, BUILDING, IN_USE, BASE, COMPOSED];

describe('reapOrphanedSandboxImages', () => {
  it('removes only the per-provider images nothing wants, and logs a refusal', async () => {
    const { db, fake, removeCalls, deps } = setup({ listed: ALL });
    let finishBuild!: () => void;
    const building = withImageTagLock(
      BUILDING,
      () => new Promise<void>((resolve) => (finishBuild = resolve)),
    );

    const sweeping = reapOrphanedSandboxImages(db, deps);
    await vi.waitFor(() => expect(removeCalls).toContain(ORPHAN_SHARED));
    expect(removeCalls).not.toContain(BUILDING);

    fake.insert(schema.cliProviders, { id: OTHER, name: 'gemini', sandboxImageTag: BUILDING });
    finishBuild();
    await building;
    await expect(sweeping).resolves.toBe(2);

    expect(removeCalls.sort()).toEqual([ORPHAN, ORPHAN_SHARED, IN_USE].sort());
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ previousDbTag: IN_USE }),
      expect.stringContaining('failed to remove'),
    );
  });

  it('removes nothing when nothing is listed, and does not throw when docker fails', async () => {
    const { db, removeCalls, deps } = setup({ listed: [] });
    await expect(reapOrphanedSandboxImages(db, deps)).resolves.toBe(0);
    const failing = { ...deps, listImageRefs: async () => Promise.reject(new Error('no docker')) };
    await expect(reapOrphanedSandboxImages(db, failing)).resolves.toBe(0);
    expect(removeCalls).toEqual([]);
  });
});

describe('reapSupersededSandboxCores', () => {
  it('removes what docker lets go, keeps a base still built on, and never throws', async () => {
    const removed: string[] = [];
    const deps = {
      listSupersededCoreIds: async () => ['sha256:old', 'sha256:parent'],
      remove: async (id: string) => {
        removed.push(id);
        return id === 'sha256:parent'
          ? { ok: false, stderr: 'image has dependent child images' }
          : { ok: true, stderr: '' };
      },
    };
    await expect(reapSupersededSandboxCores(deps)).resolves.toBe(1);
    expect(removed).toEqual(['sha256:old', 'sha256:parent']);

    const failing = {
      ...deps,
      listSupersededCoreIds: async () => Promise.reject(new Error('no docker')),
    };
    await expect(reapSupersededSandboxCores(failing)).resolves.toBe(0);
  });
});
