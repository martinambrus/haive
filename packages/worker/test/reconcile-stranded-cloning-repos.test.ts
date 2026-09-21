import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

/**
 * The boot reconciler that releases a repository stranded at `cloning`.
 *
 * Two things here must not be simplified away, and each has a case that fails when it is: the
 * QUEUE lookup (without it every `cloning` row looks stranded, including one whose job is about
 * to run) and the `status = 'cloning'` guard on the UPDATE (without it a job that started between
 * the scan and the write loses its row).
 */

const getJobs = vi.fn<() => Promise<Array<{ data: unknown }>>>();
const closed = vi.fn<() => Promise<void>>();
const constructed = vi.fn<() => void>();

vi.mock('bullmq', () => ({
  Queue: class {
    constructor() {
      constructed();
    }
    getJobs = getJobs;
    // Wrapped rather than aliased: the reconciler calls `.close().catch(...)`, so this must
    // return a promise on every path including a spy that was never given a resolved value.
    close = async (): Promise<void> => {
      await closed();
    };
  },
}));
// Mocked so the test never opens a socket; the reconciler only passes it through to the Queue.
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));

const { reconcileStrandedCloningRepos } = await import('../src/data-migrations.js');

/** Every column named anywhere in a drizzle condition tree. Structural, so the test asserts what
 *  the query actually filters on rather than matching source text. */
function conditionColumns(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string' && 'columnType' in obj) acc.push(obj.name);
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) for (const c of chunks) conditionColumns(c, acc);
  return acc;
}

interface RecordedUpdate {
  set: Record<string, unknown>;
  where: unknown;
}

function makeDb(
  cloningIds: string[],
  recorded: RecordedUpdate[],
  selectWhere: unknown[] = [],
): Database {
  return {
    select: () => ({
      from: () => ({
        where: async (cond: unknown) => {
          selectWhere.push(cond);
          return cloningIds.map((id) => ({ id }));
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async (where: unknown) => {
          recorded.push({ set, where });
        },
      }),
    }),
  } as unknown as Database;
}

describe('reconcileStrandedCloningRepos', () => {
  it('releases a repository whose job is nowhere in the queue', async () => {
    getJobs.mockReset().mockResolvedValue([{ data: { repositoryId: 'other-repo' } }]);
    const recorded: RecordedUpdate[] = [];

    await reconcileStrandedCloningRepos(makeDb(['stranded'], recorded));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.set.status).toBe('error');
    // `error` and not `ready`: it re-enables the Retry button, which renders on that status.
    expect(String(recorded[0]!.set.statusMessage)).toContain('Retry');
  });

  it('carries the status guard, so a job that starts mid-scan keeps its row', async () => {
    getJobs.mockReset().mockResolvedValue([]);
    const recorded: RecordedUpdate[] = [];

    await reconcileStrandedCloningRepos(makeDb(['stranded'], recorded));

    // Compare-and-swap, not a blind write by id. Asserted structurally rather than by reading the
    // source, so a refactor that keeps the behaviour keeps the test.
    expect(conditionColumns(recorded[0]!.where)).toContain('status');
  });

  it('leaves alone a repository whose job is still QUEUED', async () => {
    // The case the queue lookup exists for. At boot a row can legitimately be `cloning` with its
    // job waiting — created, then the worker restarted before pickup — and flipping it would
    // show an error for a repository that is about to be fine.
    getJobs.mockReset().mockResolvedValue([{ data: { repositoryId: 'waiting-repo' } }]);
    const recorded: RecordedUpdate[] = [];

    await reconcileStrandedCloningRepos(makeDb(['waiting-repo'], recorded));

    expect(recorded).toHaveLength(0);
  });

  it('never opens a queue when nothing is cloning', async () => {
    // The common case by far, and it must cost nothing: no Redis connection at all.
    getJobs.mockReset().mockResolvedValue([]);
    constructed.mockReset();
    const recorded: RecordedUpdate[] = [];

    await reconcileStrandedCloningRepos(makeDb([], recorded));

    expect(constructed).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('writes nothing when the queue cannot be read', async () => {
    // Without the queue's answer every row looks stranded, so the safe outcome is to do nothing.
    // The throw reaches `runOne`, which logs it and moves on.
    getJobs.mockReset().mockRejectedValue(new Error('redis is down'));
    const recorded: RecordedUpdate[] = [];

    await expect(reconcileStrandedCloningRepos(makeDb(['stranded'], recorded))).rejects.toThrow(
      'redis is down',
    );
    expect(recorded).toHaveLength(0);
  });

  it('only considers rows old enough that no concurrent import could have made them', async () => {
    // The api runs independently of this boot, so `POST /repos` can INSERT a `cloning` row between
    // the select and the queue read, and enqueue after it. Enqueueing changes no column, so the
    // compare-and-swap still matches and a repository whose job is genuinely queued would be given
    // a false `error` — which is the status Retry renders on, and a Retry raced against a live job
    // enqueues a second destructive rebuild. An age is the only thing that closes that window.
    getJobs.mockReset().mockResolvedValue([]);
    const selectWhere: unknown[] = [];

    await reconcileStrandedCloningRepos(makeDb(['stranded'], [], selectWhere));

    expect(conditionColumns(selectWhere[0])).toContain('updated_at');
  });

  it('never CLOSES the queue, because the Redis connection is shared', async () => {
    // The defect this exists to prevent, and it is not theoretical: `getBullRedis()` hands out one
    // shared ioredis instance, and bullmq's `Queue` does not mark a passed-in connection as
    // `shared` — so `close()` reaches `RedisConnection.close`'s `if (!this.extraOptions.shared)`
    // branch and calls `quit()` on it. A close here tears down the worker's Redis for every queue
    // that runs after this migration, at boot, on any install with a `cloning` row. It shipped in
    // the first draft of this PR and took an unrelated e2e test down with it.
    getJobs.mockReset().mockResolvedValue([]);
    closed.mockReset();

    await reconcileStrandedCloningRepos(makeDb(['stranded'], []));

    expect(closed).not.toHaveBeenCalled();
  });
});
