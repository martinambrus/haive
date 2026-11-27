import type { DbTx } from '@haive/database';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it, vi } from 'vitest';
import { setTaskSettlementTimeout, TASK_SETTLEMENT_TIMEOUT_MS } from '../src/task-fence.js';

it('bounds a settlement transaction at 60s and accepts a smaller control bound', async () => {
  const execute = vi.fn(async (_query: SQL) => undefined);
  const tx = { execute } as unknown as DbTx;
  expect(TASK_SETTLEMENT_TIMEOUT_MS).toBe(60_000);
  await setTaskSettlementTimeout(tx);
  await setTaskSettlementTimeout(tx, 25);
  expect(execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query!).sql)).toEqual([
    "SET LOCAL transaction_timeout = '60000ms'",
    "SET LOCAL transaction_timeout = '25ms'",
  ]);
});

it.each([0, -1, 0.5, NaN, 2_147_483_648])(
  'refuses an invalid timeout %s before SQL',
  async (ms) => {
    const execute = vi.fn();
    await expect(setTaskSettlementTimeout({ execute } as unknown as DbTx, ms)).rejects.toThrow(
      'Invalid task settlement transaction timeout',
    );
    expect(execute).not.toHaveBeenCalled();
  },
);

it.each(['commit', 'error', 'timeout'] as const)(
  'ends section authority on %s',
  async (outcome) => {
    const { withTaskSettlementTransaction } = await import('../src/task-fence.js');
    let signal!: AbortSignal;
    let release!: () => void;
    let callback: Promise<void> | undefined;
    const db = {
      transaction: async (fn: (tx: DbTx) => Promise<void>) => {
        callback = fn({} as DbTx);
        if (outcome === 'timeout') throw new Error('connection closed');
        await callback;
        if (outcome === 'error') throw new Error('commit failed');
      },
    };
    const run = withTaskSettlementTransaction(db as never, async (_tx, current) => {
      signal = current;
      expect(signal.aborted).toBe(false);
      if (outcome === 'timeout')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    });
    if (outcome === 'commit') await run;
    else await expect(run).rejects.toThrow();
    expect(signal.aborted).toBe(true);
    release?.();
    await callback;
  },
);
