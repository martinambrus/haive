import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

/** `openExistingRagDatabase` opens a real postgres pool, so it is the one thing the fake
 *  cannot provide. Everything else in the module (RAG_TABLE, ragDatabaseName, …) must keep
 *  its real behaviour — `ragDatabaseName` in particular, since the sanitised name is what
 *  the keeper compares on. */
const openExistingRagDatabase = vi.fn();
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openExistingRagDatabase: (...args: unknown[]) => openExistingRagDatabase(...args),
}));

const { cleanupRagForRepository } =
  await import('../src/step-engine/steps/onboarding/_rag-connection.js');

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

  it('skips blank names and dedupes by sanitized database name', async () => {
    fake = makeFakeDb([]);
    openExistingRagDatabase.mockResolvedValue(null);

    const res = await cleanupRagForRepository(fake.db, payload(['  ', 'RDApi', 'rdapi']));

    expect(res.kept).toEqual(['haive_rag_rdapi']);
    expect(openExistingRagDatabase).toHaveBeenCalledTimes(1);
  });
});
