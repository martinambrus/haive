import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  classify: vi.fn(async () => {}),
  backfill: vi.fn(async () => {}),
  owed: true,
}));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/global-kb-vector-provenance.js', () => ({
  classifyGlobalKbVectorProvenance: h.classify,
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => ({ enabled: h.enabled }),
  backfillGlobalIdentifierTsv: h.backfill,
  globalIdentifierBackfillOwed: () => h.owed,
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => unknown) =>
    (await fn({
      conn: { pg: { begin: async () => [] } },
      db: { select: () => ({ from: () => ({ where: async () => [] }) }) },
    })) ?? [],
}));

const { reconcilePendingGlobalKbSyncs } = await import('../src/queues/global-kb-sync-queue.js');

beforeEach(() => {
  h.classify.mockClear();
  h.backfill.mockClear();
});

describe('the global KB reconcile sweep', () => {
  it('classifies pre-provenance vectors, so a KB enabled after boot is not left without its dense half', async () => {
    h.enabled = true;
    await reconcilePendingGlobalKbSyncs();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the KB is disabled', async () => {
    h.enabled = false;
    await reconcilePendingGlobalKbSyncs();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.backfill).not.toHaveBeenCalled();
  });

  it('retries the identifier backfill, which the once-per-process ensure cannot', async () => {
    h.enabled = true;
    h.owed = true;
    await reconcilePendingGlobalKbSyncs();
    expect(h.backfill).toHaveBeenCalledTimes(1);
  });

  it('scans nothing for the backfill once it has converged', async () => {
    h.enabled = true;
    h.owed = false;
    await reconcilePendingGlobalKbSyncs();
    expect(h.backfill).not.toHaveBeenCalled();
  });
});
