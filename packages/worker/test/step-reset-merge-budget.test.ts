import { describe, expect, it, vi } from 'vitest';
import { is, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';

vi.mock('@haive/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/database')>()),
  resetDagCurrentLevelForRetry: vi.fn(async () => undefined),
}));

describe('resetStepAndDownstream on a step whose merge retries ran out', () => {
  it('hands only the retry counter back', async () => {
    const target = {
      id: 'ts-1',
      status: 'failed',
      runSeq: 3,
      stepIndex: 3,
      carriedWorkMs: 0,
      carriedIdleMs: 0,
      carriedUserActiveMs: 0,
      startedAt: null,
      endedAt: null,
      idleMs: 0,
      userActiveMs: 0,
      waitingStartedAt: null,
    };
    const stepWrites: Record<string, unknown>[] = [];
    const thenable = (value: unknown) => ({
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(value).then(res, rej),
    });
    // Read as a bare `where` twice: the downstream rows, then the rows the reset holds.
    let reads = 0;
    const handle = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(reads++ === 0 ? [] : [target]).then(res, rej),
            limit: async () => [target],
            // The id-ordered lock of the rows the reset writes.
            orderBy: () => ({ for: async () => [{ id: target.id }] }),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === schema.taskSteps && 'status' in values) stepWrites.push(values);
          return {
            where: () => ({ ...thenable(undefined), returning: async () => [{ epoch: 1 }] }),
          };
        },
      }),
      delete: () => ({ where: () => thenable(undefined) }),
    };
    const db = {
      ...handle,
      transaction: async (fn: (tx: unknown) => unknown) => fn(handle),
    } as unknown as Database;

    await resetStepAndDownstream(db, 'task-1', '12-worktree-cleanup', 0);

    const state = stepWrites[0]?.mergeResolveState;
    expect(is(state, SQL)).toBe(true);
    const { sql: text } = new PgDialect().sqlToQuery(state as SQL);
    expect(text).toContain(`jsonb_set(`);
    expect(text).toContain(`'{conflictRetries}', '0'::jsonb`);
    expect(text).toContain(`jsonb_typeof(`);
  });
});
