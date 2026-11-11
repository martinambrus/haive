import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({
  outcome: 'held',
  chmod: vi.fn(),
  chown: vi.fn(),
  unreadable: false,
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
    if (h.unreadable) return null;
    return { kind: 'file', stats: { uid: h.uid, gid: h.gid, mode: h.mode } };
  },
  chmodNoFollow: h.chmod,
  chownNoFollow: h.chown,
}));

import { resyncHaiveProjections, resyncWithKeptMetadata } from './set-aside.js';
import { keptFilesOf } from './kept-metadata.js';

const metadata = { '.haive-data/plan.json': { owner: { uid: 1000, gid: 1000 }, mode: 0o600 } };
function fixture(captured = metadata) {
  let pending: Record<string, typeof metadata> | null = { '/repo': captured };
  const execute = vi.fn(async () => {
    pending = null;
  });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ revision: 1, written: 1, kept: pending }] }),
      }),
    }),
    execute,
  } as unknown as Database;
  return { db, execute, pending: () => pending };
}

beforeEach(() => {
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(process, 'getgid').mockReturnValue(0);
  h.outcome = 'held';
  h.unreadable = false;
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
