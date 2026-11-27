import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@haive/database';
import { logger, type CliExecJobPayload } from '@haive/shared';
import { serializeError } from '@haive/shared/logger';
import { enqueueReservedInvocation } from './enqueue-reserved-invocation.js';

const payload = {
  invocationId: 'reserved-run',
  taskId: 'task',
  taskStepId: 'step',
} as CliExecJobPayload;

function releaseDb(releaseError?: unknown) {
  const where = vi.fn(async (_condition: SQL) => {
    if (releaseError) throw releaseError;
  });
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update } as unknown as Database, update, set, where };
}

afterEach(() => vi.restoreAllMocks());

describe('enqueueReservedInvocation', () => {
  it('keeps a successful enqueue reserved and passes the payload by identity', async () => {
    const h = releaseDb();
    const enqueueCliInvocation = vi.fn(async () => {});
    await enqueueReservedInvocation(h.db, { enqueueCliInvocation }, payload);
    expect(enqueueCliInvocation.mock.calls[0]).toEqual([payload]);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('compiles release as exact invocation equality, never a step-wide predicate', async () => {
    const h = releaseDb();
    const queueError = new Error('queue unavailable');
    await expect(
      enqueueReservedInvocation(
        h.db,
        {
          enqueueCliInvocation: async () => {
            throw queueError;
          },
        },
        payload,
      ),
    ).rejects.toBe(queueError);
    expect(h.update).toHaveBeenCalledExactlyOnceWith(schema.cliInvocations);
    expect(h.set).toHaveBeenCalledExactlyOnceWith({ supersededAt: expect.any(Date) });
    expect(h.where).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(h.where.mock.calls[0]![0]);
    // Compile the real predicate: a task/step-wide release or another run id must fail.
    expect(query.sql).toBe('"cli_invocations"."id" = $1');
    expect(query.params).toEqual(['reserved-run']);
  });

  it('logs a sanitized release failure and rethrows the queue error by identity', async () => {
    const releaseError = Object.assign(new Error('query failed: private-token'), {
      query: 'update cli_invocations set superseded_at = $1',
      params: ['private-token'],
      cause: Object.assign(new Error('driver detail private-token'), { code: '08006' }),
    });
    const h = releaseDb(releaseError);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const queueError = new Error('queue unavailable');
    await expect(
      enqueueReservedInvocation(
        h.db,
        {
          enqueueCliInvocation: async () => {
            throw queueError;
          },
        },
        payload,
      ),
    ).rejects.toBe(queueError);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { err: serializeError(releaseError), invocationId: payload.invocationId },
      'failed to release unqueued invocation reservation',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-token');
  });
});
