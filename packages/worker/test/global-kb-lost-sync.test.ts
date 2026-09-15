import { GLOBAL_KB_JOB_NAMES } from '@haive/shared';
import { describe, expect, it } from 'vitest';
import { pickLostSyncs } from '../src/queues/global-kb-sync-queue.js';

// The reconcile re-queues the sync of an active entry still `pending` with nothing queued to embed
// it. What counts as "already queued" is the whole safety of that: re-queuing an entry whose upsert
// is merely waiting behind a slow embed adds a duplicate on every sweep, and on a CPU-only host one
// entry takes minutes to embed, so the backlog would feed itself.
const job = (
  entryId: string,
  reason: 'upsert' | 'delete',
  name: string = GLOBAL_KB_JOB_NAMES.SYNC_ENTRY,
) => ({ name, data: { entryId, namespace: 'house', reason } });

const pending = [
  { id: 'lost', namespace: 'house' },
  { id: 'queued', namespace: 'house' },
];
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('pickLostSyncs', () => {
  it('re-queues only the entry with no upsert waiting or running', () => {
    expect(ids(pickLostSyncs(pending, [job('queued', 'upsert')]))).toEqual(['lost']);
  });

  it('does not count a delete job, which never embeds an active entry', () => {
    expect(ids(pickLostSyncs(pending, [job('queued', 'delete')]))).toEqual(['lost', 'queued']);
  });

  it('does not count another job name carrying the same entry id', () => {
    const purge = job('queued', 'upsert', GLOBAL_KB_JOB_NAMES.PURGE_ARCHIVED);
    expect(ids(pickLostSyncs(pending, [purge]))).toEqual(['lost', 'queued']);
  });

  it('does not count a scheduler job that carries no payload', () => {
    const tick = { name: GLOBAL_KB_JOB_NAMES.RECONCILE_PENDING, data: {} };
    expect(ids(pickLostSyncs(pending, [tick]))).toEqual(['lost', 'queued']);
  });

  it('returns nothing when every pending entry is already queued', () => {
    expect(pickLostSyncs(pending, [job('lost', 'upsert'), job('queued', 'upsert')])).toEqual([]);
  });
});
