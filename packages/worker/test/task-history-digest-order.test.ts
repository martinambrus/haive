import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { buildTaskHistoryDigest } from '../src/step-engine/steps/workflow/_task-history-digest.js';

/** Captures the ORDER BY the steps read is sent, as SQL text; the events read is not asked about. */
async function capture(): Promise<string[]> {
  const orders: string[] = [];
  const rows = {
    where: () => ({
      orderBy: (...cols: unknown[]) => {
        orders.push(
          cols
            .map((c) => new PgDialect().sqlToQuery(c as SQL).sql.replace(/"task_\w+"\./g, ''))
            .join(', '),
        );
        return Promise.resolve([]);
      },
    }),
  };
  const db = { select: () => ({ from: () => rows }) } as unknown as Database;
  await buildTaskHistoryDigest(db, 'task-1');
  return orders;
}

interface Row {
  id: string;
  stepIndex: number;
  runSeq: number | null;
  round: number;
}

/** Sorts rows by the captured ORDER BY terms, the way Postgres would. */
function sortBy(order: string, rows: Row[]): string[] {
  const terms = order.split(', ').map((t) => ({
    key: (/"(step_index|run_seq|round)"/.exec(t)?.[1] ?? '') as string,
    nullsLast: /nulls last/i.test(t),
  }));
  const prop = { step_index: 'stepIndex', run_seq: 'runSeq', round: 'round' } as const;
  const val = (r: Row, k: string) => r[prop[k as keyof typeof prop]];
  return [...rows]
    .sort((a, b) => {
      for (const t of terms) {
        const x = val(a, t.key);
        const y = val(b, t.key);
        if (x === y) continue;
        if (x === null) return t.nullsLast ? 1 : -1;
        if (y === null) return t.nullsLast ? -1 : 1;
        return x - y;
      }
      return 0;
    })
    .map((r) => r.id);
}

describe('buildTaskHistoryDigest step order', () => {
  it('reads steps in run order: run_seq, then step_index, then round, rows without run_seq last', async () => {
    const orders = await capture();
    const rows: Row[] = [
      { id: 'legacy', stepIndex: 1, runSeq: null, round: 0 },
      { id: 'late', stepIndex: 2, runSeq: 9, round: 0 },
      { id: 'tie-r1', stepIndex: 5, runSeq: 4, round: 1 },
      { id: 'tie-r0', stepIndex: 5, runSeq: 4, round: 0 },
      { id: 'tie-low-index', stepIndex: 3, runSeq: 4, round: 2 },
      { id: 'first', stepIndex: 40, runSeq: 1, round: 0 },
    ];
    expect(sortBy(orders[0]!, rows)).toEqual([
      'first',
      'tie-low-index',
      'tie-r0',
      'tie-r1',
      'late',
      'legacy',
    ]);
  });
});
