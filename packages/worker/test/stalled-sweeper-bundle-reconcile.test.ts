import { STOP_SETTLE_EVENTS } from '@haive/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const reconcile = vi.fn<(db: Database) => Promise<void>>(async () => undefined);
const reconcileRepos = vi.fn<(db: Database) => Promise<void>>(async () => undefined);

vi.mock('../src/data-migrations.js', () => ({
  reconcileStrandedSyncingBundles: reconcile,
  reconcileStrandedCloningRepos: reconcileRepos,
}));

const { StalledTaskSweeper, defaultStopDeps } = await import('../src/queues/stalled-redrive.js');

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

it('re-drives a lost Stop from sweep', async () => {
  const failedAt = new Date(0);
  const queued = vi.spyOn(defaultStopDeps, 'queuedStoppedTaskIds').mockResolvedValue(new Set());
  const enqueue = vi.spyOn(defaultStopDeps, 'enqueueStopSettle').mockResolvedValue(undefined);
  const insert = vi.fn();
  const chain = (rows: unknown[]): unknown => {
    const result: unknown = new Proxy(() => result, {
      get: (_target, key) =>
        key === 'then'
          ? (ok: (value: unknown[]) => unknown) => Promise.resolve(rows).then(ok)
          : result,
      apply: () => result,
    });
    return result;
  };
  const db = new Proxy(emptyDb(), {
    get: (target, key) => {
      if (key === 'select')
        return (fields: object = {}) =>
          chain('failedAt' in fields ? [{ taskId: 'stopped', userId: 'u1', failedAt }] : []);
      if (key === 'insert')
        return () => ({
          values: (value: unknown) => {
            insert(value);
            return { returning: async () => [{ id: 'stamp' }] };
          },
        });
      return Reflect.get(target, key);
    },
  });
  try {
    expect(await new StalledTaskSweeper({ db, staleMs: 1 }).sweep()).toEqual({ redriven: 1 });
    expect(enqueue).toHaveBeenCalledWith('stopped', 'u1', failedAt.toISOString());
    expect(insert).toHaveBeenCalledWith({
      taskId: 'stopped',
      eventType: STOP_SETTLE_EVENTS.REDRIVEN,
      payload: { failedAt: failedAt.toISOString() },
    });
  } finally {
    queued.mockRestore();
    enqueue.mockRestore();
  }
});
