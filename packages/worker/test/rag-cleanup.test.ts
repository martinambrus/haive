import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { createFakeRagLock } from './rag-lock-fake.js';

const lockFake = vi.hoisted(() => ({ value: undefined as unknown }));

/** `openExistingRagDatabase` opens a real postgres pool, so it is the one thing the fake
 *  cannot provide. Everything else in the module (RAG_TABLE, ragDatabaseName, …) must keep
 *  its real behaviour — `ragDatabaseName` in particular, since the sanitised name is what
 *  the keeper compares on. */
const openExistingRagDatabase = vi.fn();
vi.mock('@haive/shared/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/rag')>();
  const { createFakeRagLock: create } = await import('./rag-lock-fake.js');
  const fake = create(actual);
  lockFake.value = fake;
  return {
    ...actual,
    openExistingRagDatabase: (...args: unknown[]) => openExistingRagDatabase(...args),
    tryAcquireRagSyncLock: fake.tryAcquireRagSyncLock,
  };
});
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRedis: () => ({}),
}));

const { RagCleanupDeferredError, cleanupRagForRepository } =
  await import('../src/step-engine/steps/onboarding/_rag-connection.js');
const fakeLock = lockFake.value as ReturnType<typeof createFakeRagLock>;

/** Best-effort textual rendering of a drizzle SQL object, by walking `queryChunks`. */
function sqlText(sqlObj: unknown): string {
  if (sqlObj == null || typeof sqlObj !== 'object') return String(sqlObj);
  const obj = sqlObj as Record<string, unknown>;
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) {
    return chunks
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object') {
          const inner = c as Record<string, unknown>;
          if (typeof inner.value === 'string') return inner.value;
          if (Array.isArray(inner.value)) return inner.value.join('');
          if (Array.isArray((inner as { queryChunks?: unknown }).queryChunks))
            return sqlText(inner);
        }
        return '';
      })
      .join('');
  }
  return JSON.stringify(obj);
}

type RepoRow = { id: string; onboardingTooling: unknown; onboardingEnvironment: unknown };

interface FakeDb {
  db: Database;
  calls: string[];
  queueResult: (rows: unknown[]) => void;
  queueError: (err: Error) => void;
}

/** `repos` is what keeper 2 sees. `execute` serves the pg_stat_activity probe, the
 *  no-mirror fallback query and the DROP, in the order the function issues them. */
function makeFakeDb(repos: RepoRow[] = []): FakeDb {
  const calls: string[] = [];
  const queue: Array<{ rows?: unknown[]; err?: Error }> = [];
  const execute = vi.fn(async (sqlObj: unknown) => {
    calls.push(sqlText(sqlObj));
    const next = queue.shift();
    if (next?.err) throw next.err;
    return next?.rows ?? [];
  });
  const db = {
    execute,
    query: { repositories: { findMany: async () => repos } },
  } as unknown as Database;
  return {
    db,
    calls,
    queueResult: (rows) => queue.push({ rows }),
    queueError: (err) => queue.push({ err }),
  };
}

/** A per-project store holding `rows` rows after the delete removes `deleted` of them. */
function fakeStore(opts: { deleted?: number; remaining?: number }): {
  conn: unknown;
  statements: string[];
  closed: () => boolean;
} {
  const statements: string[] = [];
  let didClose = false;
  const conn = {
    mode: 'internal',
    embeddingDimensions: 2560,
    pg: {
      unsafe: async (q: string) => {
        statements.push(q);
        if (q.startsWith('DELETE')) return { count: opts.deleted ?? 0 };
        if (q.includes('LIMIT 1')) return (opts.remaining ?? 0) > 0 ? [{ '?column?': 1 }] : [];
        return [];
      },
    },
    close: async () => {
      didClose = true;
    },
  };
  return { conn, statements, closed: () => didClose };
}

const mirrorRepo = (id: string, projectName: string, ragMode = 'internal'): RepoRow => ({
  id,
  onboardingTooling: { schemaVersion: 1, tooling: { ragMode } },
  onboardingEnvironment: {
    schemaVersion: 1,
    envDetectData: { project: { name: projectName } },
    confirmedValues: {},
  },
});

const payload = (projectNames: string[]) => ({
  repositoryId: 'deleted-repo',
  userId: 'user-1',
  projectNames,
});

let fake: FakeDb;

beforeEach(() => {
  openExistingRagDatabase.mockReset();
  fakeLock.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cleanupRagForRepository', () => {
  it('does nothing when there are no project names', async () => {
    fake = makeFakeDb();
    const res = await cleanupRagForRepository(fake.db, payload([]));

    expect(res).toEqual({ dropped: [], kept: [] });
    expect(fake.calls).toHaveLength(0);
    expect(openExistingRagDatabase).not.toHaveBeenCalled();
  });

  it('deletes the repo rows and drops the database when nothing is left', async () => {
    fake = makeFakeDb([]);
    const store = fakeStore({ deleted: 9199, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);
    fake.queueResult([]); // pg_stat_activity: nobody connected
    fake.queueResult([]); // DROP

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res.dropped).toEqual(['haive_rag_rdapi']);
    expect(store.statements[0]).toContain('DELETE FROM ai_rag_embeddings');
    // The pool must be closed before the DROP, or our own backend blocks it.
    expect(store.closed()).toBe(true);
    expect(fake.calls[fake.calls.length - 1]).toContain(
      'DROP DATABASE IF EXISTS "haive_rag_rdapi"',
    );
  });

  it('KEEPS the database when another repo still has rows in it', async () => {
    // The measured data-loss case: two repos share one store, one is deleted.
    fake = makeFakeDb([]);
    const store = fakeStore({ deleted: 9199, remaining: 9278 });
    openExistingRagDatabase.mockResolvedValue(store.conn);

    const res = await cleanupRagForRepository(fake.db, payload(['elmont-rs']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_elmont_rs'] });
    expect(fake.calls.some((c) => c.includes('DROP DATABASE'))).toBe(false);
  });

  it('KEEPS the database when a surviving repo claims it, even with zero rows left', async () => {
    // The mirror-restored blind spot: this repo has no onboarding task at all, so the old
    // task_steps collision query could not see it and dropped its store.
    fake = makeFakeDb([mirrorRepo('survivor', 'elmont-rs')]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);

    const res = await cleanupRagForRepository(fake.db, payload(['elmont-rs']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_elmont_rs'] });
    expect(fake.calls.some((c) => c.includes('DROP DATABASE'))).toBe(false);
  });

  it('KEEPS it when a survivor names the same database under a different raw name', async () => {
    // `elmont.rs` and `elmont-rs` both sanitise to haive_rag_elmont_rs. The old query
    // compared RAW names while the DROP targeted the sanitised one, so this survivor did
    // not protect its own store.
    fake = makeFakeDb([mirrorRepo('survivor', 'elmont.rs')]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);

    const res = await cleanupRagForRepository(fake.db, payload(['elmont-rs']));

    expect(res.kept).toEqual(['haive_rag_elmont_rs']);
  });

  it('does not treat an external-mode survivor as a claim', async () => {
    fake = makeFakeDb([mirrorRepo('survivor', 'elmont-rs', 'ddev')]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);
    fake.queueResult([]); // pg_stat_activity
    fake.queueResult([]); // DROP

    const res = await cleanupRagForRepository(fake.db, payload(['elmont-rs']));

    expect(res.dropped).toEqual(['haive_rag_elmont_rs']);
  });

  it('KEEPS the database when another backend is connected', async () => {
    fake = makeFakeDb([]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);
    fake.queueResult([{ '?column?': 1 }]); // pg_stat_activity: someone is in there

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
    expect(fake.calls.some((c) => c.includes('DROP DATABASE'))).toBe(false);
  });

  it('never creates a database that is not there', async () => {
    fake = makeFakeDb([]);
    openExistingRagDatabase.mockResolvedValue(null);

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
    expect(fake.calls.some((c) => c.includes('CREATE DATABASE'))).toBe(false);
    expect(fake.calls.some((c) => c.includes('DROP DATABASE'))).toBe(false);
  });

  it('keeps the database when the row cleanup itself fails (fail-safe)', async () => {
    fake = makeFakeDb([]);
    openExistingRagDatabase.mockRejectedValue(new Error('connection refused'));

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
  });

  it('keeps the database when the survivor check itself errors (fail-safe)', async () => {
    const db = {
      execute: vi.fn(),
      query: {
        repositories: {
          findMany: async () => {
            throw new Error('db down');
          },
        },
      },
    } as unknown as Database;

    const res = await cleanupRagForRepository(db, payload(['RDApi']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
    expect(openExistingRagDatabase).not.toHaveBeenCalled();
  });

  it('keeps the database when the DROP throws', async () => {
    fake = makeFakeDb([]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);
    fake.queueResult([]); // pg_stat_activity
    fake.queueError(new Error('permission denied'));

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
  });

  it('retries the DROP once when the database is still in use', async () => {
    fake = makeFakeDb([]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);
    fake.queueResult([]); // pg_stat_activity
    const inUse = Object.assign(new Error('is being accessed by other users'), { code: '55006' });
    fake.queueError(inUse);
    fake.queueResult([]); // the retry succeeds

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res.dropped).toEqual(['haive_rag_rdapi']);
    expect(fake.calls.filter((c) => c.includes('DROP DATABASE'))).toHaveLength(2);
  });

  it('retries the DROP once when drizzle wraps the in-use error', async () => {
    fake = makeFakeDb([]);
    const store = fakeStore({ deleted: 10, remaining: 0 });
    openExistingRagDatabase.mockResolvedValue(store.conn);
    fake.queueResult([]); // pg_stat_activity
    const inUse = Object.assign(new Error('is being accessed by other users'), { code: '55006' });
    fake.queueError(Object.assign(new Error('Failed query: DROP DATABASE'), { cause: inUse }));
    fake.queueResult([]); // the retry succeeds

    const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

    expect(res.dropped).toEqual(['haive_rag_rdapi']);
    expect(fake.calls.filter((c) => c.includes('DROP DATABASE'))).toHaveLength(2);
  });

  it('skips blank names and dedupes by sanitized database name', async () => {
    fake = makeFakeDb([]);
    openExistingRagDatabase.mockResolvedValue(null);

    const res = await cleanupRagForRepository(fake.db, payload(['  ', 'RDApi', 'rdapi']));

    expect(res.kept).toEqual(['haive_rag_rdapi']);
    expect(openExistingRagDatabase).toHaveBeenCalledTimes(1);
  });

  describe('the repository RAG sync lock', () => {
    it('defers by throwing, and touches nothing, while a sync holds the lock', async () => {
      fake = makeFakeDb([]);
      const store = fakeStore({ deleted: 10, remaining: 0 });
      openExistingRagDatabase.mockResolvedValue(store.conn);
      fakeLock.state.held.add('deleted-repo');

      await expect(cleanupRagForRepository(fake.db, payload(['RDApi']))).rejects.toBeInstanceOf(
        RagCleanupDeferredError,
      );

      expect(openExistingRagDatabase).not.toHaveBeenCalled();
      expect(store.statements).toEqual([]);
      expect(fake.calls).toEqual([]);
      expect(fakeLock.state.handles).toHaveLength(0);
    });

    it('defers the same way when Redis cannot be reached', async () => {
      fake = makeFakeDb([]);
      openExistingRagDatabase.mockResolvedValue(fakeStore({}).conn);
      fakeLock.state.redisDown = true;

      const err = await cleanupRagForRepository(fake.db, payload(['RDApi'])).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(RagCleanupDeferredError);
      expect((err as Error).message).toContain('deleted-repo');
      expect(openExistingRagDatabase).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
    });

    it('holds the lock through the DROP and releases it exactly once', async () => {
      fake = makeFakeDb([]);
      const store = fakeStore({ deleted: 9199, remaining: 0 });
      let heldAtDrop: boolean | null = null;
      openExistingRagDatabase.mockResolvedValue(store.conn);
      const execute = fake.db.execute as unknown as (q: unknown) => Promise<unknown>;
      fake.db.execute = (async (q: unknown) => {
        if (sqlText(q).includes('DROP DATABASE')) {
          heldAtDrop = fakeLock.state.held.has('deleted-repo');
        }
        return execute(q);
      }) as unknown as Database['execute'];

      const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

      expect(res.dropped).toEqual(['haive_rag_rdapi']);
      expect(heldAtDrop).toBe(true);
      expect(fakeLock.state.handles).toHaveLength(1);
      expect(fakeLock.state.handles[0]!.released).toBe(1);
      expect(fakeLock.state.held.size).toBe(0);
    });

    it('releases the lock when the cleanup fails', async () => {
      fake = makeFakeDb([]);
      openExistingRagDatabase.mockRejectedValue(new Error('connection refused'));
      await cleanupRagForRepository(fake.db, payload(['RDApi']));
      expect(fakeLock.state.handles[0]!.released).toBe(1);

      const broken = {
        execute: vi.fn(),
        query: {
          repositories: {
            findMany: async () => {
              throw new Error('db down');
            },
          },
        },
      } as unknown as Database;
      await cleanupRagForRepository(broken, payload(['RDApi']));
      expect(fakeLock.state.handles[1]!.released).toBe(1);
      expect(fakeLock.state.held.size).toBe(0);
    });

    it('keeps the database when the lock is lost after the rows went and before the drop', async () => {
      fake = makeFakeDb([]);
      const store = fakeStore({ deleted: 10, remaining: 0 });
      openExistingRagDatabase.mockResolvedValue(store.conn);
      const execute = fake.db.execute as unknown as (q: unknown) => Promise<unknown>;
      fake.db.execute = (async (q: unknown) => {
        if (sqlText(q).includes('pg_stat_activity')) fakeLock.state.handles[0]!.lost = true;
        return execute(q);
      }) as unknown as Database['execute'];

      const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

      expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
      expect(fake.calls.some((c) => c.includes('DROP DATABASE'))).toBe(false);
      expect(fakeLock.state.handles[0]!.released).toBe(1);
    });

    it('sends no store statement once the lock is lost, and keeps the database', async () => {
      fake = makeFakeDb([]);
      const store = fakeStore({ deleted: 10, remaining: 0 });
      openExistingRagDatabase.mockResolvedValue(store.conn);
      fakeLock.state.loseOnTake = true;

      const res = await cleanupRagForRepository(fake.db, payload(['RDApi']));

      expect(store.statements).toEqual([]);
      expect(res).toEqual({ dropped: [], kept: ['haive_rag_rdapi'] });
      expect(fakeLock.state.handles[0]!.released).toBe(1);
    });
  });
});
