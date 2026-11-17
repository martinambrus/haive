import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { logger } from '@haive/shared';
import type { Database } from '@haive/database';
import { backfillToolUsage } from '../src/queues/cli-exec/tool-usage-backfill.js';

const old = {
  source: 'stream',
  agents: { assigned: ['reviewer'], read: [] },
  tools: { Read: 9 },
};
const transcript = JSON.stringify({ type: 'assistant', message: { id: 'a', content: [] } });
type Row = {
  id: string;
  endedAt: Date;
  providerName: string;
  streamLog: string | null;
  toolUsage: typeof old & { reads?: { version?: number; coverage?: string } | null };
};
const row = (i: number, reads?: Row['toolUsage']['reads']): Row => ({
  id: `00000000-0000-0000-0000-00000000000${i}`,
  endedAt: new Date('2026-10-01'),
  providerName: 'claude-code',
  streamLog: transcript,
  toolUsage: { ...old, ...(reads === undefined ? {} : { reads }) },
});
const opts = { budgetMs: 1000, batchSize: 2, apply: true };

function fixture(rows: Row[]) {
  const dialect = new PgDialect();
  const predicates: string[] = [];
  const writes: Record<string, unknown>[] = [];
  let race = false;
  let failId: string | null = null;
  let countQueries = 0;
  // A narrow seam for paging, CAS and failures. Real SQL/null/version semantics are
  // covered by read-exposure-backfill-db.test.ts, rather than inferred from this fake.
  const matches = (where: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const q = dialect.sqlToQuery(where);
    predicates.push(q.sql);
    expect(q.sql).toContain("IS DISTINCT FROM 'object'");
    expect(q.sql).toMatch(/::numeric < \$[0-9]+/);
    const expected = q.params.find((p) => typeof p === 'string' && p.startsWith('{'));
    const cursor = q.sql.includes(') < (');
    return rows.filter((r) => {
      const reads = r.toolUsage.reads;
      const missing =
        reads == null ||
        typeof reads.version !== 'number' ||
        (reads.version < 1 &&
          (!q.sql.includes('"stream_log" is not null') || r.streamLog !== null));
      const id = q.params.find((p) => typeof p === 'string' && p.startsWith('00000000-'));
      return (
        missing &&
        (!id || (cursor ? r.id < String(id) : id === r.id)) &&
        (expected === undefined || expected === JSON.stringify(r.toolUsage))
      );
    });
  };
  const db = {
    select(fields: Record<string, unknown>) {
      const count = 'n' in fields;
      if (count) countQueries++;
      let selected = rows;
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
          selected = matches(condition);
          return query;
        },
        orderBy: () => {
          selected = selected.toSorted((a, b) => b.id.localeCompare(a.id));
          return query;
        },
        limit: (n: number) => {
          selected = selected.slice(0, n);
          return query;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(count ? [{ n: selected.length }] : selected.map((r) => ({ ...r }))).then(
            resolve,
          ),
      };
      return query;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => ({
          returning: async () => {
            writes.push(values);
            if (race) {
              race = false;
              rows[0]!.toolUsage = {
                ...rows[0]!.toolUsage,
                agents: { assigned: ['new'], read: [] },
              };
            }
            const selected = matches(condition);
            if (selected.some((r) => r.id === failId)) throw new Error('update failed');
            return selected.map((r) => {
              Object.assign(r, values);
              return { id: r.id };
            });
          },
        }),
      }),
    }),
  } as unknown as Database;
  return {
    db,
    writes,
    predicates,
    race: () => {
      race = true;
    },
    fail: (id: string | null) => {
      failId = id;
    },
    counts: () => countQueries,
  };
}

it('converges existing, JSON-null and old reads, preserves other facts and fences a race', async () => {
  const rows = [
    row(0),
    row(1, null),
    row(2, { version: 0 }),
    row(3, { version: 1, coverage: 'none' }),
    row(4, { version: 2, coverage: 'none' }),
  ];
  rows[0]!.streamLog = null;
  const f = fixture(rows);
  expect(await backfillToolUsage(f.db, { ...opts, apply: false })).toMatchObject({
    examined: 3,
    written: 0,
    remaining: 0,
  });
  expect(await backfillToolUsage(f.db, opts)).toMatchObject({
    examined: 3,
    written: 3,
    remaining: 0,
  });
  expect(await backfillToolUsage(f.db, opts)).toMatchObject({
    examined: 0,
    written: 0,
    remaining: 0,
  });
  expect(rows[0]!.toolUsage).toMatchObject({ ...old, reads: { version: 1, coverage: 'none' } });
  rows[0]!.streamLog = transcript;
  rows[0]!.toolUsage.reads = { version: 0 };
  expect(await backfillToolUsage(f.db, opts)).toMatchObject({
    examined: 1,
    written: 1,
    remaining: 0,
  });
  rows[0]!.toolUsage.reads = { version: 0 };
  f.race();
  expect(await backfillToolUsage(f.db, opts)).toMatchObject({
    examined: 1,
    written: 0,
    remaining: 1,
  });
  expect(await backfillToolUsage(f.db, opts)).toMatchObject({
    examined: 1,
    written: 1,
    remaining: 0,
  });
  expect(rows[0]!.toolUsage.agents.assigned).toEqual(['new']);
  expect(f.writes.every((w) => Object.keys(w).join() === 'toolUsage')).toBe(true);
});

it('logs a failed row update and still converges the next row, then retries the failed row', async () => {
  const rows = [row(0), row(1)];
  const f = fixture(rows);
  f.fail(rows[1]!.id);
  // Capture the real child logger's shared stream without exposing transcript contents.
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  const lines: string[] = [];
  const spy = vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
  try {
    expect(await backfillToolUsage(f.db, opts)).toMatchObject({
      examined: 2,
      written: 1,
      remaining: 1,
    });
    expect(rows[0]!.toolUsage.reads?.version).toBe(1);
    expect(rows[1]!.toolUsage.reads).toBeUndefined();
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ invocationId: rows[1]!.id, level: 50 }),
    );
    f.fail(null);
    expect(await backfillToolUsage(f.db, opts)).toMatchObject({
      examined: 1,
      written: 1,
      remaining: 0,
    });
  } finally {
    spy.mockRestore();
  }
});

it('retains an older record when its transcript has been swept, including on the next pass', async () => {
  const retained = row(0, { version: 0, coverage: 'full' });
  retained.streamLog = null;
  const f = fixture([retained]);
  const before = structuredClone(retained.toolUsage);
  for (let pass = 0; pass < 2; pass++) {
    expect(await backfillToolUsage(f.db, opts)).toMatchObject({ written: 0, remaining: 0 });
    expect(retained.toolUsage).toEqual(before);
  }
});

it('skips the count query when the first page is empty', async () => {
  const f = fixture([]);
  expect(await backfillToolUsage(f.db, opts)).toMatchObject({ examined: 0, remaining: 0 });
  expect(f.counts()).toBe(0);
});
