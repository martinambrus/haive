import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  classify: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/global-kb-vector-provenance.js', () => ({
  classifyGlobalKbVectorProvenance: h.classify,
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => ({ enabled: h.enabled }),
  withGlobalKb: async () => [],
}));

const { reconcilePendingGlobalKbSyncs } = await import('../src/queues/global-kb-sync-queue.js');

beforeEach(() => {
  h.classify.mockClear();
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
  });
});
