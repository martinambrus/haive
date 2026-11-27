import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  error: undefined as unknown,
  owed: false,
  add: vi.fn(async () => {}),
  classify: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
}));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/global-kb-vector-provenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/global-kb-vector-provenance.js')>();
  return {
    classifyGlobalKbVectorProvenance: async (
      ...args: Parameters<typeof actual.classifyGlobalKbVectorProvenance>
    ) => {
      await h.classify();
      return actual.classifyGlobalKbVectorProvenance(...args);
    },
  };
});
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Queue: class {
    getJobs = async () => [];
    add = h.add;
    close = async () => {};
  },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => ({ enabled: h.enabled }),
  resolveGlobalKbEnabled: async () => h.enabled,
  retryOwedGlobalIdentifierBackfill: h.retry,
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => unknown) =>
    (await fn({
      conn: {
        pg: {
          begin: async () => [],
          unsafe: async () => {
            if (h.error) throw h.error;
            return [];
          },
        },
      },
      db: {
        select: (columns: object) => ({
          from: () => ({
            where: async () =>
              h.owed && 'namespace' in columns ? [{ id: 'owed-entry', namespace: 'house' }] : [],
          }),
        }),
      },
    })) ?? [],
}));

const { reconcilePendingGlobalKbSyncs } = await import('../src/queues/global-kb-sync-queue.js');

beforeEach(() => {
  h.enabled = true;
  h.error = undefined;
  h.owed = false;
  h.add.mockClear();
  h.classify.mockClear();
  h.retry.mockClear();
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
    expect(h.retry).not.toHaveBeenCalled();
  });

  it('asks for an owed identifier backfill, which the once-per-process ensure cannot retry', async () => {
    h.enabled = true;
    await reconcilePendingGlobalKbSyncs();
    expect(h.retry).toHaveBeenCalledTimes(1);
  });
});

it('reaches identifier retry and lost-sync requeue after an ordinary classify SQL failure with a sweep signal', async () => {
  h.error = Object.assign(new Error('permission denied'), { code: '42501' });
  h.owed = true;
  await reconcilePendingGlobalKbSyncs({ signal: new AbortController().signal });
  expect(h.retry).toHaveBeenCalledOnce();
  expect(h.add).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ entryId: 'owed-entry' }),
    expect.any(Object),
  );
});
it('propagates a coded classify deadline to the tick owner', async () => {
  h.error = Object.assign(new Error('private details'), { code: '57014' });
  await expect(
    reconcilePendingGlobalKbSyncs({ signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'GLOBAL_KB_DEADLINE' });
  expect(h.retry).not.toHaveBeenCalled();
  expect(h.add).not.toHaveBeenCalled();
});
