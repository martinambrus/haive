import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { REPOSITORY_TASKS_LOCK_TIMEOUT_MS } from '@haive/database';
import { logger } from '@haive/shared';
import { HttpError, type AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { REPOSITORY_BUSY, boundedLockWait } from '../src/lib/repository-busy.js';

const dialect = new PgDialect();

function stubTx() {
  const log: string[] = [];
  const tx = {
    execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      log.push(dialect.sqlToQuery(query).sql);
    },
  };
  return { tx: tx as never, log };
}

const lockTimeout = () =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
  });

describe('boundedLockWait', () => {
  it('pins the bound to 30 seconds', () => {
    expect(REPOSITORY_TASKS_LOCK_TIMEOUT_MS).toBe(30_000);
  });

  it('sets the bound, takes the lock, then lifts the bound, in that order', async () => {
    const { tx, log } = stubTx();
    await boundedLockWait(tx, async () => {
      log.push('take');
    });
    expect(log).toEqual([
      `SET LOCAL lock_timeout = '${REPOSITORY_TASKS_LOCK_TIMEOUT_MS}ms'`,
      'take',
      'SET LOCAL lock_timeout = DEFAULT',
    ]);
    expect(log[0]).toBe("SET LOCAL lock_timeout = '30000ms'");
  });

  it('returns what the lock call returned', async () => {
    const { tx } = stubTx();
    const row = { id: 'r' };
    expect(await boundedLockWait(tx, async () => row)).toBe(row);
  });

  it('answers a lock timeout as a 409 and executes nothing after it', async () => {
    const { tx, log } = stubTx();
    const err = await boundedLockWait(tx, async () => {
      log.push('take');
      throw lockTimeout();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, message: REPOSITORY_BUSY });
    expect(log).toEqual(["SET LOCAL lock_timeout = '30000ms'", 'take']);
  });

  it('logs the timeout without naming any one caller', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { tx } = stubTx();
      const timeout = lockTimeout();
      await boundedLockWait(tx, async () => {
        throw timeout;
      }).catch(() => undefined);
      expect(warn).toHaveBeenCalledTimes(1);
      const [fields, message] = warn.mock.calls[0]!;
      expect(fields).toEqual({ err: timeout });
      // Task starts, plan routes, upgrades, repository deletes, tooling saves and relinks all take this wait.
      expect(message).not.toMatch(/task/i);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([new Error('boom'), new HttpError(404, 'Not found')])(
    'rethrows %s unchanged',
    async (thrown) => {
      const { tx } = stubTx();
      const err = await boundedLockWait(tx, async () => {
        throw thrown;
      }).catch((e: unknown) => e);
      expect(err).toBe(thrown);
    },
  );

  describe('through the error handler', () => {
    const answer = async (fn: () => Promise<unknown>) => {
      const app = new Hono<AppEnv>();
      app.get('/', async () => {
        await fn();
        return new Response('ok');
      });
      app.onError(errorHandler);
      return app.request('/');
    };

    it('answers the wrapped timeout 409 with the busy message', async () => {
      const { tx } = stubTx();
      const res = await answer(() =>
        boundedLockWait(tx, async () => {
          throw lockTimeout();
        }),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'The repository is busy, try again', code: null });
    });

    it('still answers a bare timeout 500: the mapping belongs to the wrapper', async () => {
      const res = await answer(async () => {
        throw lockTimeout();
      });
      expect(res.status).toBe(500);
    });
  });
});
