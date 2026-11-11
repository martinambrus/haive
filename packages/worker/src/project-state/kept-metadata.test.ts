import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({
  outcome: 'held',
  chmod: vi.fn(),
  chown: vi.fn(),
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
  lstatNoFollow: async () => ({ kind: 'file', stats: { uid: h.uid, gid: h.gid, mode: h.mode } }),
  chmodNoFollow: h.chmod,
  chownNoFollow: h.chown,
}));

import { resyncHaiveProjections, resyncWithKeptMetadata } from './set-aside.js';
import { keptFilesOf } from './kept-metadata.js';

const metadata = { '.haive-data/plan.json': { owner: { uid: 1000, gid: 1000 }, mode: 0o600 } };
function fixture() {
  let pending: Record<string, typeof metadata> | null = { '/repo': metadata };
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
  h.uid = 0;
  h.gid = 0;
  h.mode = 0o644;
  h.chmod.mockReset().mockImplementation(async (_root, _path, mode) => {
    h.mode = typeof mode === 'function' ? mode(h.mode) : mode;
  });
  h.chown.mockReset().mockImplementation(async (_root, _path, owner) => {
    h.uid = owner.uid;
    h.gid = owner.gid;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('persisted projection metadata', () => {
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

  it('keeps the obligation when restoring metadata fails, then retries before handing off ownership', async () => {
    const f = fixture();
    h.outcome = 'applied';
    h.chmod.mockRejectedValueOnce(new Error('transient chmod failure'));
    expect(await resyncHaiveProjections(f.db, 'repo-1', '/repo')).toBe(false);
    expect(f.pending()).not.toBeNull();
    expect(h.chown).not.toHaveBeenCalled();
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
