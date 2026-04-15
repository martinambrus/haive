import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { removeOrphanedPreviousImage } from '../src/queues/cli-exec-queue.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

function makeDb(findFirstResult: { id: string } | undefined): Database {
  return {
    query: {
      cliProviders: {
        findFirst: async () => findFirstResult,
      },
    },
  } as unknown as Database;
}

function makeRunner(opts: { exists?: boolean; removeOk?: boolean } = {}): {
  runner: DockerRunner;
  inspectCalls: string[];
  removeCalls: string[];
} {
  const inspectCalls: string[] = [];
  const removeCalls: string[] = [];
  const exists = opts.exists ?? true;
  const runner: DockerRunner = {
    build: async () => {
      throw new Error('build should not be called');
    },
    run: async () => {
      throw new Error('run should not be called');
    },
    inspect: async (tag: string) => {
      inspectCalls.push(tag);
      return { exists, imageId: exists ? 'sha256:abc' : null };
    },
    remove: async (ref: string) => {
      removeCalls.push(ref);
      return {
        ok: opts.removeOk ?? true,
        stderr: opts.removeOk === false ? 'image in use' : '',
      };
    },
  };
  return { runner, inspectCalls, removeCalls };
}

describe('removeOrphanedPreviousImage', () => {
  it('no-ops when previousDbTag is null (first build)', async () => {
    const db = makeDb(undefined);
    const { runner, inspectCalls, removeCalls } = makeRunner();
    const result = await removeOrphanedPreviousImage(
      db,
      { providerId: 'p1', previousDbTag: null, newTag: 'haive-cli-sandbox:provider-p1-abc' },
      runner,
    );
    expect(result).toEqual({ removed: false, reason: 'no-previous' });
    expect(inspectCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it('no-ops when previousDbTag equals newTag (idempotent force rebuild)', async () => {
    const db = makeDb(undefined);
    const { runner, inspectCalls, removeCalls } = makeRunner();
    const tag = 'haive-cli-sandbox:provider-p1-abc123';
    const result = await removeOrphanedPreviousImage(
      db,
      { providerId: 'p1', previousDbTag: tag, newTag: tag },
      runner,
    );
    expect(result).toEqual({ removed: false, reason: 'same-tag' });
    expect(inspectCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it('keeps the previous image when another provider still references it (shared tag case)', async () => {
    const db = makeDb({ id: 'p2' });
    const { runner, inspectCalls, removeCalls } = makeRunner();
    const result = await removeOrphanedPreviousImage(
      db,
      {
        providerId: 'p1',
        previousDbTag: 'haive-cli-sandbox:claude-code-1.2.3',
        newTag: 'haive-cli-sandbox:claude-code-1.2.4',
      },
      runner,
    );
    expect(result).toEqual({ removed: false, reason: 'still-in-use' });
    expect(inspectCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it('skips remove when the previous image no longer exists on the host', async () => {
    const db = makeDb(undefined);
    const { runner, inspectCalls, removeCalls } = makeRunner({ exists: false });
    const result = await removeOrphanedPreviousImage(
      db,
      {
        providerId: 'p1',
        previousDbTag: 'haive-cli-sandbox:provider-p1-oldhash',
        newTag: 'haive-cli-sandbox:provider-p1-newhash',
      },
      runner,
    );
    expect(result).toEqual({ removed: false, reason: 'missing' });
    expect(inspectCalls).toEqual(['haive-cli-sandbox:provider-p1-oldhash']);
    expect(removeCalls).toEqual([]);
  });

  it('removes the previous image when no other provider uses it and it exists', async () => {
    const db = makeDb(undefined);
    const { runner, inspectCalls, removeCalls } = makeRunner({ exists: true, removeOk: true });
    const result = await removeOrphanedPreviousImage(
      db,
      {
        providerId: 'p1',
        previousDbTag: 'haive-cli-sandbox:provider-p1-oldhash',
        newTag: 'haive-cli-sandbox:provider-p1-newhash',
      },
      runner,
    );
    expect(result).toEqual({ removed: true, reason: 'removed' });
    expect(inspectCalls).toEqual(['haive-cli-sandbox:provider-p1-oldhash']);
    expect(removeCalls).toEqual(['haive-cli-sandbox:provider-p1-oldhash']);
  });

  it('reports remove-failed when the docker remove call fails (image in use, etc.)', async () => {
    const db = makeDb(undefined);
    const { runner, inspectCalls, removeCalls } = makeRunner({ exists: true, removeOk: false });
    const result = await removeOrphanedPreviousImage(
      db,
      {
        providerId: 'p1',
        previousDbTag: 'haive-cli-sandbox:provider-p1-oldhash',
        newTag: 'haive-cli-sandbox:provider-p1-newhash',
      },
      runner,
    );
    expect(result).toEqual({ removed: false, reason: 'remove-failed' });
    expect(inspectCalls).toEqual(['haive-cli-sandbox:provider-p1-oldhash']);
    expect(removeCalls).toEqual(['haive-cli-sandbox:provider-p1-oldhash']);
  });

  it('removes a stale hash-keyed tag after an extras edit (full regression path)', async () => {
    const db = makeDb(undefined);
    const { runner, removeCalls } = makeRunner({ exists: true, removeOk: true });
    const oldTag = 'haive-cli-sandbox:provider-abc-0123456789abcdef';
    const newTag = 'haive-cli-sandbox:provider-abc-fedcba9876543210';
    const result = await removeOrphanedPreviousImage(
      db,
      { providerId: 'abc', previousDbTag: oldTag, newTag },
      runner,
    );
    expect(result.removed).toBe(true);
    expect(removeCalls).toEqual([oldTag]);
  });
});
