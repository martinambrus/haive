import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { retainedComposedImageRefs } from '../src/lsp/composed-evidence.js';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { COMPOSED_IMAGE_REPO } from '../src/sandbox/image-composer.js';
import { reapStaleComposedImages } from '../src/sandbox/composed-image-reaper.js';
import { withImageTagLock } from '../src/sandbox/image-tag-lock.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    queueMicrotask(() => {
      const tag = `${COMPOSED_IMAGE_REPO}:old`;
      const line =
        args[0] === 'images'
          ? tag
          : args[0] === 'image'
            ? `sha256:old|2000-01-01T00:00:00Z|${tag}`
            : '';
      child.stdout.emit('data', Buffer.from(`${line}\n`));
      child.emit('close', 0);
    });
    return child;
  }),
}));
const tag = `${COMPOSED_IMAGE_REPO}:old`;
const ref = {
  tag,
  imageId: 'sha256:old',
  identityHash: 'hash',
  inputs: { rtkVersion: '0.42.4', baseImageId: null, rtkPin: null, requestedHash: 'h' },
};
function taskDb(read: () => unknown): Database {
  return {
    select: () => ({ from: () => ({ where: async () => [{ metadata: read() }] }) }),
  } as unknown as Database;
}
function metadata(kind: 'effective' | 'prior' | 'verifying') {
  return {
    composedLspImageRefs: { schemaVersion: 1, entries: [{ providerId: 'p', [kind]: ref }] },
  };
}
beforeEach(() => vi.clearAllMocks());
describe('composed reaper durable ownership', () => {
  it.each(['effective', 'prior', 'verifying'] as const)(
    "protects a live task's %s without a container",
    async (kind) => {
      const remove = vi.fn(async () => ({ ok: true, stderr: '' }));
      const runner = fakeDockerRunner({
        inspect: async () => ({ exists: true, imageId: 'sha256:old' }),
        remove,
      });
      expect(
        await reapStaleComposedImages(
          1,
          Date.UTC(2026, 1),
          runner,
          taskDb(() => metadata(kind)),
        ),
      ).toBe(0);
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it('reads ownership again inside the same tag turn as publication and removal', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    const held = withImageTagLock(tag, async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await enteredPromise;
    let reads = 0;
    let firstRead!: () => void;
    const readPromise = new Promise<void>((r) => {
      firstRead = r;
    });
    let published = false;
    const db = taskDb(() => {
      reads++;
      firstRead();
      return published ? metadata('effective') : null;
    });
    const remove = vi.fn(async () => ({ ok: true, stderr: '' }));
    const run = reapStaleComposedImages(
      1,
      Date.UTC(2026, 1),
      fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: 'sha256:old' }), remove }),
      db,
    );
    try {
      // One event-loop turn also lets a parent lacking the ownership read fail
      // without leaving the tag turn held for the next control.
      await Promise.race([readPromise, new Promise<void>((resolve) => setImmediate(resolve))]);
      expect(reads).toBe(1);
      published = true;
    } finally {
      release();
      await held;
    }
    expect(await run).toBe(0);
    expect(reads).toBe(2);
    expect(remove).not.toHaveBeenCalled();
  });
  it('keeps images when retained ownership cannot be decoded', async () => {
    const remove = vi.fn(async () => ({ ok: true, stderr: '' }));
    expect(
      await reapStaleComposedImages(
        1,
        Date.UTC(2026, 1),
        fakeDockerRunner({
          inspect: async () => ({ exists: true, imageId: 'sha256:old' }),
          remove,
        }),
        taskDb(() => ({ composedLspImageRefs: { schemaVersion: 99, entries: [] } })),
      ),
    ).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});

it('uses a bound jsonb_exists key test for retained references', async () => {
  let query: { sql: string; params: unknown[] } | undefined;
  const db = {
    select: () => ({
      from: () => ({
        where: async (where: SQL) => {
          query = new PgDialect().sqlToQuery(where);
          return [];
        },
      }),
    }),
  } as unknown as Database;
  await retainedComposedImageRefs(db);
  expect(query?.sql).toContain('jsonb_exists(');
  expect(query?.params).toContain('composedLspImageRefs');
});
