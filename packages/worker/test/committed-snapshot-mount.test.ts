import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { resolveInvocationRepoMount } from '../src/queues/cli-exec/resolvers.js';
const pin = {
  version: 1 as const,
  userId: randomUUID(),
  repositoryId: randomUUID(),
  taskId: randomUUID(),
  commitOid: 'a'.repeat(40),
  treeOid: 'b'.repeat(40),
  inventoryId: randomUUID(),
  inventorySha256: 'c'.repeat(64),
};
const refs = { snapshotRef: pin, baseSnapshotRef: { ...pin, inventoryId: randomUUID() } };
const resolved = vi.hoisted(() => ({
  target: {
    workerRoot: '/owned/target/tree',
    subpath: 'owner/_scratch/task/target/tree',
    tracked: new Set(['.env']),
  },
  base: {
    workerRoot: '/owned/base/tree',
    subpath: 'owner/_scratch/task/base/tree',
    tracked: new Set(),
  },
}));
vi.mock('../src/repo/committed-snapshot.js', async (original) => ({
  ...(await original<object>()),
  resolveTaskCommittedSnapshots: vi.fn(async () => resolved),
}));
import { resolveTaskCommittedSnapshots } from '../src/repo/committed-snapshot.js';

describe('snapshot mount precedence', () => {
  it.each(['read-only folder', 'integration worktree'])(
    'resolves the pin before the %s branch',
    async (branch) => {
      const query = vi.fn(() => {
        throw new Error('live checkout must not be resolved');
      });
      const db = { query: { tasks: { findFirst: query } } } as unknown as Database;
      const mounts = await resolveInvocationRepoMount(
        db,
        pin.taskId,
        branch === 'integration worktree' ? '.haive/worktrees/integration' : undefined,
        refs,
      );
      expect(resolveTaskCommittedSnapshots).toHaveBeenCalledWith(db, pin.taskId, refs);
      expect(query).not.toHaveBeenCalled();
      expect(mounts.workspaceKind).toBe('snapshot');
      expect(mounts.hasRepo).toBe(true);
      expect(mounts.repoMount).toEqual({
        source: 'haive_repos',
        target: '/haive/workdir',
        subpath: resolved.target.subpath,
        readOnly: true,
      });
      expect(mounts.baseMount).toEqual({
        source: 'haive_repos',
        target: '/haive/diff-base',
        subpath: resolved.base.subpath,
        readOnly: true,
      });
    },
  );
});
