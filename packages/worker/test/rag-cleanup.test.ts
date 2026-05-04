import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { cleanupRagForRepository } from '../src/step-engine/steps/onboarding/_rag-connection.js';

/** Records every `haiveDb.execute()` SQL the function emits so the test can
 *  assert call ordering without standing up a real postgres. We extract a
 *  best-effort textual representation by walking drizzle's `queryChunks`
 *  array (where templated SQL stores its literal fragments) and falling
 *  back to JSON for unrecognised shapes. */
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
          if (Array.isArray((inner as { queryChunks?: unknown }).queryChunks)) {
            return sqlText(inner);
          }
        }
        return '';
      })
      .join('');
  }
  return JSON.stringify(obj);
}

interface ExecuteCall {
  sql: string;
}

interface FakeDb {
  db: Database;
  calls: ExecuteCall[];
  /** Set what the next `execute()` call returns. `kind: 'collision'` means a
   *  collision-check query (the function expects an array; `rows.length > 0`
   *  short-circuits to "kept"). For DDL (`pg_terminate_backend`,
   *  `DROP DATABASE`), the function ignores the return value. */
  queueResult: (rows: unknown[]) => void;
  /** Throw an error from the next execute() — used to simulate DROP failures. */
  queueError: (err: Error) => void;
}

function makeFakeDb(): FakeDb {
  const calls: ExecuteCall[] = [];
  const queue: Array<{ rows?: unknown[]; err?: Error }> = [];
  const execute = vi.fn(async (sqlObj: unknown) => {
    calls.push({ sql: sqlText(sqlObj) });
    const next = queue.shift();
    if (next?.err) throw next.err;
    return next?.rows ?? [];
  });
  // Only `execute` is touched by cleanupRagForRepository. The rest of the
  // Database surface stays unimplemented — any unintentional usage will
  // throw and surface as a test failure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = { execute } as unknown as Database;
  return {
    db,
    calls,
    queueResult: (rows) => queue.push({ rows }),
    queueError: (err) => queue.push({ err }),
  };
}

let fake: FakeDb;

beforeEach(() => {
  fake = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cleanupRagForRepository', () => {
  it('returns immediately when projectNames is empty (no execute calls)', async () => {
    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: [],
    });
    expect(result).toEqual({ dropped: [], kept: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it('keeps the database when a surviving task references the same project name', async () => {
    fake.queueResult([{ '?column?': 1 }]); // collision check returns a row

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['RDApi'],
    });

    expect(result.dropped).toEqual([]);
    expect(result.kept).toEqual(['haive_rag_rdapi']);
    // Exactly one query — the collision check. No terminate_backend / no DROP.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.sql).toMatch(/repository_id IS NOT NULL/);
    expect(fake.calls[0]!.sql).toMatch(/ragMode/);
  });

  it('drops the database when no surviving task references the project name', async () => {
    fake.queueResult([]); // collision check returns no rows
    fake.queueResult([]); // pg_terminate_backend
    fake.queueResult([]); // DROP DATABASE

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['RDApi'],
    });

    expect(result.dropped).toEqual(['haive_rag_rdapi']);
    expect(result.kept).toEqual([]);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]!.sql).toMatch(/repository_id IS NOT NULL/);
    expect(fake.calls[1]!.sql).toContain('pg_terminate_backend');
    expect(fake.calls[1]!.sql).toContain("'haive_rag_rdapi'");
    expect(fake.calls[2]!.sql).toContain('DROP DATABASE IF EXISTS "haive_rag_rdapi"');
  });

  it('keeps the database when DROP fails (caught + logged, not re-thrown)', async () => {
    fake.queueResult([]); // no collision
    fake.queueResult([]); // pg_terminate_backend ok
    fake.queueError(new Error('database "haive_rag_rdapi" is being accessed by other users'));

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['RDApi'],
    });

    expect(result.dropped).toEqual([]);
    expect(result.kept).toEqual(['haive_rag_rdapi']);
  });

  it('keeps the database when the collision check itself errors (fail-safe)', async () => {
    fake.queueError(new Error('connection lost'));

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['RDApi'],
    });

    // Better to leak an orphan database than to drop one that another live
    // repo depends on. The test enforces this fail-safe stance.
    expect(result.dropped).toEqual([]);
    expect(result.kept).toEqual(['haive_rag_rdapi']);
    expect(fake.calls).toHaveLength(1);
  });

  it('skips empty / whitespace-only project names without consuming a query slot', async () => {
    fake.queueResult([]); // for the one valid name
    fake.queueResult([]); // pg_terminate_backend
    fake.queueResult([]); // DROP

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['', '   ', 'RDApi'],
    });

    expect(result.dropped).toEqual(['haive_rag_rdapi']);
    expect(fake.calls).toHaveLength(3);
  });

  it('dedupes by sanitized database name so the same DB is not processed twice', async () => {
    // 'RDApi' and 'rdapi' both sanitize to 'haive_rag_rdapi'. The function
    // tracks a Set on the dbName so the second occurrence is silently skipped.
    fake.queueResult([]); // collision check (only runs once)
    fake.queueResult([]); // pg_terminate_backend
    fake.queueResult([]); // DROP

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['RDApi', 'rdapi'],
    });

    expect(result.dropped).toEqual(['haive_rag_rdapi']);
    expect(result.kept).toEqual([]);
    expect(fake.calls).toHaveLength(3);
  });

  it('processes multiple distinct project names independently', async () => {
    // alpha → kept (collision), beta → dropped, gamma → kept (collision)
    fake.queueResult([{ '?column?': 1 }]); // alpha collision
    fake.queueResult([]); // beta no collision
    fake.queueResult([]); // beta pg_terminate_backend
    fake.queueResult([]); // beta DROP
    fake.queueResult([{ '?column?': 1 }]); // gamma collision

    const result = await cleanupRagForRepository(fake.db, {
      repositoryId: 'r1',
      userId: 'u1',
      projectNames: ['Alpha', 'Beta', 'Gamma'],
    });

    expect(result.dropped).toEqual(['haive_rag_beta']);
    expect(result.kept.sort()).toEqual(['haive_rag_alpha', 'haive_rag_gamma']);
    expect(fake.calls).toHaveLength(5);
  });
});
