import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const h = vi.hoisted(() => ({
  outcome: 'held',
  chmod: vi.fn(),
  chown: vi.fn(),
  unreadable: false,
  absent: false,
  uid: 0,
  gid: 0,
  mode: 0o644,
}));
vi.mock('../repo/git-operation.js', () => ({ gitOperationInProgress: async () => false }));
vi.mock('./sync.js', () => ({
  syncProjectStateFromCheckout: async () => ({ outcome: h.outcome }),
}));
vi.mock('./refresh.js', () => ({ refreshProjectState: async () => true }));
vi.mock('../plan/sync-checkout.js', () => ({ syncPlanFromCheckout: async () => {} }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: async (_anchor: string, _rel: string, opts?: { strict?: boolean }) => {
    if (h.unreadable && opts?.strict) throw new Error('metadata unreadable');
    if (h.unreadable || h.absent) return null;
    return { kind: 'file', stats: { uid: h.uid, gid: h.gid, mode: h.mode } };
  },
  chmodNoFollow: h.chmod,
  chownNoFollow: h.chown,
}));

import { holdProjectionMove, withProjectionMove } from './projection-move.js';
import {
  restoreKeptMetadata,
  resyncHaiveProjections,
  resyncWithKeptMetadata,
} from './set-aside.js';
import { restorePendingKeptMetadata, keptFilesOf, type KeptMetadata } from './kept-metadata.js';

const metadata: KeptMetadata = {
  '.haive-data/plan.json': { owner: { uid: 1000, gid: 1000 }, mode: 0o600 },
};
function fixture(captured: KeptMetadata = metadata) {
  let pending: Record<string, KeptMetadata> | null = { '/repo': structuredClone(captured) };
  const dialect = new PgDialect();
  const execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.trimStart().startsWith('UPDATE')) {
      const key = query.params[0] as string;
      const path = query.params[1] as string;
      const expected = JSON.parse(query.params.at(-1) as string);
      if (
        !query.sql.includes('AND kept_metadata ->') ||
        isDeepStrictEqual(pending?.[key]?.[path], expected)
      ) {
        if (pending?.[key]) delete pending[key][path];
        if (pending?.[key] && Object.keys(pending[key]).length === 0) delete pending[key];
        if (pending && Object.keys(pending).length === 0) pending = null;
      }
    }
  });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ revision: 1, written: 1, kept: structuredClone(pending) }],
        }),
      }),
    }),
    execute,
  } as unknown as Database;
  return {
    db,
    execute,
    pending: () => pending,
    capture: (next: KeptMetadata) => {
      pending = { '/repo': structuredClone(next) };
    },
  };
}

beforeEach(() => {
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(process, 'getgid').mockReturnValue(0);
  h.outcome = 'held';
  h.unreadable = false;
  h.absent = false;
  h.uid = 0;
  h.gid = 0;
  h.mode = 0o644;
  h.chmod.mockReset().mockImplementation(async (_root, _path, mode) => {
    h.mode = typeof mode === 'function' ? mode(h.mode) : mode;
  });
  h.chown.mockReset().mockImplementation(async (_root, _path, owner) => {
    h.uid = owner.uid;
    h.gid = owner.gid;
    h.mode &= ~0o6000;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('persisted projection metadata', () => {
  it('retains an absent captured file until recreated, then consumes it once', async () => {
    const f = fixture();
    h.outcome = 'absent';
    h.absent = true;
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(true);
    expect(f.pending()).toEqual({ '/repo': metadata });
    expect(h.chown).not.toHaveBeenCalled();
    h.absent = false;
    h.outcome = 'applied';
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(true);
    expect(h.mode).toBe(0o600);
    expect(f.pending()).toBeNull();
    h.mode = 0o644;
    await resyncHaiveProjections(f.db, 'repo-1', '/repo');
    expect(h.mode).toBe(0o644);
  });

  it('warns once for an absent capture across repeated recovery sweeps', async () => {
    const f = fixture();
    h.outcome = 'applied';
    await resyncHaiveProjections(f.db, 'repo-1', '/repo');
    f.capture(metadata);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    h.absent = true;
    for (let tick = 0; tick < 3; tick++)
      expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(true);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ repoPath: '/repo', path: '.haive-data/plan.json' }),
      expect.stringContaining('absent'),
    );
    expect(f.pending()).toEqual({ '/repo': metadata });
  });

  it('retains a different capture at the same path during the guarded clear', async () => {
    const f = fixture();
    const replacement = { '.haive-data/plan.json': { owner: { uid: 42, gid: 42 }, mode: 0o640 } };
    expect(
      await restorePendingKeptMetadata(f.db, 'repo-1', '/repo', async () => {
        f.capture(replacement);
        return true;
      }),
    ).toBe(true);
    expect(f.pending()).toEqual({ '/repo': replacement });
  });

  it('leaves a second capture pending when it races the guarded clear', async () => {
    const f = fixture();
    const captured = {
      ...metadata,
      '.haive-data/plan.md': { owner: { uid: 42, gid: 42 }, mode: 0o640 },
    };
    expect(
      await restorePendingKeptMetadata(f.db, 'repo-1', '/repo', async () => {
        f.capture(captured);
        return true;
      }),
    ).toBe(true);
    expect(f.pending()).toEqual({
      '/repo': { '.haive-data/plan.md': captured['.haive-data/plan.md'] },
    });
  });

  it('consumes a successful file while retaining only the file whose restore failed', async () => {
    const second = { owner: { uid: 42, gid: 42 }, mode: 0o640 };
    const f = fixture({ ...metadata, '.haive-data/plan.md': second });
    const restored: string[] = [];
    expect(
      await restorePendingKeptMetadata(f.db, 'repo-1', '/repo', async (_root, kept) => {
        const [path] = [...kept.keys()];
        restored.push(path!);
        return path !== '.haive-data/plan.md';
      }),
    ).toBe(false);
    expect(f.pending()).toEqual({ '/repo': { '.haive-data/plan.md': second } });
    expect(restored).toEqual(['.haive-data/plan.json', '.haive-data/plan.md']);
  });

  it('waits for an in-flight restore and clear before a new move captures', async () => {
    const f = fixture();
    let resume!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const recovery = restorePendingKeptMetadata(f.db, 'repo-1', '/repo', async () => {
      started();
      await pause;
      return true;
    });
    await ready;
    let moved = false;
    const move = withProjectionMove(async () => {
      await holdProjectionMove('/repo');
      moved = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(moved).toBe(false);
    } finally {
      resume();
      await recovery;
      await move;
    }
    expect(moved).toBe(true);
  });

  it('preserves captured special mode bits when ownership changes', async () => {
    const f = fixture({
      '.haive-data/plan.json': { owner: { uid: 1000, gid: 1000 }, mode: 0o6400 },
    });
    h.outcome = 'applied';
    await resyncHaiveProjections(f.db, 'repo-1', '/repo');
    expect(h.mode).toBe(0o6400);
    expect(h.uid).toBe(1000);
    expect(f.pending()).toBeNull();
  });

  it('retains metadata when an inode cannot be read and settles after access returns', async () => {
    const f = fixture();
    h.outcome = 'applied';
    h.unreadable = true;
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(false);
    expect(f.pending()).not.toBeNull();
    h.unreadable = false;
    h.absent = false;
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(true);
    expect(h.mode).toBe(0o600);
  });

  it('preserves a mode and group changed since creation', async () => {
    const f = fixture();
    h.outcome = 'applied';
    h.mode = 0o640;
    h.gid = 42;
    await resyncHaiveProjections(f.db, 'repo-1', '/repo');
    expect(h.mode).toBe(0o640);
    expect(h.gid).toBe(42);
    expect(h.uid).toBe(1000);
    expect(f.pending()).toBeNull();
  });

  it('survives a failed sync, settles on the next success after restart, and is consumed once', async () => {
    const f = fixture();
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(false);
    expect(f.pending()).toEqual({ '/repo': metadata });
    expect(h.chown).not.toHaveBeenCalled();
    // No KeptFiles map survives this simulated restart; only the database row does.
    h.outcome = 'applied';
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(true);
    expect(h.mode).toBe(0o600);
    expect(h.uid).toBe(1000);
    expect(h.gid).toBe(1000);
    expect(f.pending()).toBeNull();
    await resyncHaiveProjections(f.db, 'repo-1', '/repo');
    expect(h.chown).toHaveBeenCalledOnce();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('keeps the obligation when chmod fails after handing back ownership, then retries it', async () => {
    const f = fixture();
    h.outcome = 'applied';
    h.chmod.mockRejectedValueOnce(new Error('transient chmod failure'));
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(false);
    expect(f.pending()).not.toBeNull();
    expect(h.chown).toHaveBeenCalledOnce();
    expect(h.uid).toBe(1000);
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(true);
    expect(h.mode).toBe(0o600);
    expect(h.uid).toBe(1000);
    expect(f.pending()).toBeNull();
  });

  it('does not consume an in-memory map when resync is held', async () => {
    const f = fixture();
    const kept = keptFilesOf(metadata);
    // Remember uses one statement; model its durable write without consuming the row.
    f.execute.mockImplementation(async () => {});
    expect(await resyncWithKeptMetadata(f.db, 'repo-1', '/repo', kept)).toBe(false);
    expect(kept.size).toBe(1);
    expect(h.chown).not.toHaveBeenCalled();
  });
});

it('evicts the oldest warn-once path at the 4096-entry bound', async () => {
  h.absent = true;
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const restore = (index: number) =>
    restoreKeptMetadata(
      '/warning-bound',
      keptFilesOf({ ['file-' + index]: { owner: { uid: 1000, gid: 1000 }, mode: 0o600 } }),
    );
  for (let index = 0; index <= 4096; index++) await restore(index);
  expect(warn).toHaveBeenCalledTimes(4097);
  await restore(4096);
  expect(warn).toHaveBeenCalledTimes(4097);
  await restore(0);
  expect(warn).toHaveBeenCalledTimes(4098);
});
