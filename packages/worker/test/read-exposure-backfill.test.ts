import { expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@haive/database';
import { backfillToolUsage } from '../src/queues/cli-exec/tool-usage-backfill.js';

it('converges existing, JSON-null and old reads in one pass, preserves other facts, and reselects an older version', async () => {
  const old = {
    source: 'stream',
    agents: { assigned: ['reviewer'], read: [] },
    tools: { Read: 9 },
  };
  const rows = [
    undefined,
    null,
    { version: 0 },
    { version: 1, coverage: 'none' },
    { version: 2, coverage: 'none' },
  ].map((reads, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i}`,
    endedAt: new Date('2026-10-01'),
    providerName: 'claude-code',
    streamLog: null,
    toolUsage: { ...old, ...(reads === undefined ? {} : { reads }) },
  }));
  const dialect = new PgDialect();
  const predicates: string[] = [];
  const writes: Record<string, unknown>[] = [];
  let race = false;
  // A narrow seam: interpret only the migration's selection and CAS vocabulary, and retain
  // the generated SQL so accidentally reverting to IS NULL cannot pass the convergence check.
  const matches = (where: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const q = dialect.sqlToQuery(where);
    predicates.push(q.sql);
    const readSelection = q.sql.includes("'reads'");
    if (readSelection) {
      expect(q.sql).toContain("IS DISTINCT FROM 'object'");
      expect(q.sql).toMatch(/::numeric < \$[0-9]+/);
    }
    const expected = q.params.find((p) => typeof p === 'string' && p.startsWith('{'));
    const cursor = q.sql.includes(') < (');
    return rows.filter((r) => {
      const reads = r.toolUsage?.reads;
      const missing = readSelection
        ? reads == null || !('version' in reads) || Number(reads.version) < 1
        : r.toolUsage == null;
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
            return matches(condition).map((r) => {
              Object.assign(r, values);
              return { id: r.id };
            });
          },
        }),
      }),
    }),
  } as unknown as Database;
  const opts = { budgetMs: 1000, batchSize: 2, apply: true };
  expect(await backfillToolUsage(db, { ...opts, apply: false })).toMatchObject({
    examined: 3,
    written: 0,
    remaining: 0,
  });
  expect(await backfillToolUsage(db, opts)).toMatchObject({
    examined: 3,
    written: 3,
    remaining: 0,
  });
  expect(await backfillToolUsage(db, opts)).toMatchObject({
    examined: 0,
    written: 0,
    remaining: 0,
  });
  expect(rows[0]!.toolUsage).toMatchObject({ ...old, reads: { version: 1, coverage: 'none' } });
  rows[0]!.toolUsage.reads = { version: 0 };
  expect(await backfillToolUsage(db, opts)).toMatchObject({
    examined: 1,
    written: 1,
    remaining: 0,
  });
  rows[0]!.toolUsage.reads = { version: 0 };
  race = true;
  expect(await backfillToolUsage(db, opts)).toMatchObject({
    examined: 1,
    written: 0,
    remaining: 1,
  });
  expect(await backfillToolUsage(db, opts)).toMatchObject({
    examined: 1,
    written: 1,
    remaining: 0,
  });
  expect(rows[0]!.toolUsage.agents.assigned).toEqual(['new']);
  expect(writes.every((w) => Object.keys(w).join() === 'toolUsage')).toBe(true);
  expect(predicates.some((p) => p.includes("'version'"))).toBe(true);
});
