import { expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { RepoJobPayload } from '@haive/shared';

const h = vi.hoisted(() => ({
  moved: false,
  resettle: vi.fn(),
  metadata: vi.fn(),
  aside: vi.fn(),
}));
vi.mock('./git-push.js', async (original) => ({
  ...(await original<typeof import('./git-push.js')>()),
  detectOrigin: async () => true,
  originGitRun: async () => ({ code: 0, stdout: '', stderr: '' }),
  gitRun: async (_dir: string, args: string[]) => {
    if (args[0] === 'merge') h.moved = true;
    const stdout =
      args[0] === 'symbolic-ref'
        ? 'main'
        : args[0] === 'rev-list'
          ? '0 1'
          : args[0] === 'merge-base'
            ? 'base'
            : args.includes('FETCH_HEAD^{commit}')
              ? 'target'
              : h.moved
                ? 'target'
                : 'before';
    return { code: 0, stdout, stderr: '' };
  },
}));
vi.mock('../plan/merge.js', () => ({ headCommit: async () => (h.moved ? 'target' : 'before') }));
vi.mock('../step-engine/git-merge.js', () => ({ handBackAfterMove: async () => {} }));
vi.mock('../project-state/set-aside.js', () => ({
  MOVE_ATTEMPTS: 3,
  setAsideHaiveProjections: h.aside,
  restoreProjectionsInTx: async () => ({ outcome: 'clean' }),
  resyncHaiveProjections: async () => false,
  resyncWithKeptMetadata: h.resettle,
  restoreKeptMetadata: h.metadata,
}));

import { fastForward } from './refresh.js';

it('refresh leaves captured metadata for durable recovery after a failed re-sync', async () => {
  const kept = new Map([
    [
      '.haive-data/plan.json',
      {
        bytes: Buffer.from('{}'),
        index: null,
        untracked: true,
        owner: { uid: 1000, gid: 1000 },
        mode: 0o600,
      },
    ],
  ]);
  h.aside.mockResolvedValue({ outcome: 'set-aside', kept });
  h.resettle.mockResolvedValue(false);
  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: async () => [],
    query: { tasks: { findMany: async () => [] } },
  } as unknown as Database;
  await fastForward(
    db,
    { source: 'github_https', repositoryId: 'r1', userId: 'u1' } as RepoJobPayload,
    '/repo',
  );
  expect(h.resettle).toHaveBeenCalledWith(db, 'r1', '/repo', kept);
  expect(h.metadata).not.toHaveBeenCalled();
  expect(kept.size).toBe(1);
});
