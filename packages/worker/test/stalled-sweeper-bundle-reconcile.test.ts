import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const reconcile = vi.fn<(db: Database) => Promise<void>>(async () => undefined);
const reconcileRepos = vi.fn<(db: Database) => Promise<void>>(async () => undefined);

vi.mock('../src/data-migrations.js', () => ({
  reconcileStrandedSyncingBundles: reconcile,
  reconcileStrandedCloningRepos: reconcileRepos,
}));

const { StalledTaskSweeper } = await import('../src/queues/stalled-redrive.js');

function emptyDb(): Database {
  const chain: unknown = new Proxy(() => chain, {
    get: (_target, key) =>
      key === 'then' ? (ok: (rows: unknown[]) => unknown) => Promise.resolve([]).then(ok) : chain,
    apply: () => chain,
  });
  return chain as Database;
}

describe('StalledTaskSweeper', () => {
  it('reconciles the bundles stranded at syncing on every sweep', async () => {
    const db = emptyDb();

    await new StalledTaskSweeper({ db }).sweep();

    expect(reconcile.mock.calls.map(([arg]) => arg === db)).toEqual([true]);
    expect(reconcileRepos.mock.calls.map(([arg]) => arg === db)).toEqual([true]);
  });
});
