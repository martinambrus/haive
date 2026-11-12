import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import type { Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ kb: undefined as unknown }));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) => fn({ db: h.kb }),
}));
import * as migrations from '../src/data-migrations.js';

const db = {} as Database;
const original = [...migrations.DATA_MIGRATIONS];
let stop: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  stop?.();
  stop = undefined;
  await vi.advanceTimersByTimeAsync(0);
  migrations.DATA_MIGRATIONS.splice(0, migrations.DATA_MIGRATIONS.length, ...original);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function install(run: migrations.DataMigration['run']) {
  migrations.DATA_MIGRATIONS.splice(0, migrations.DATA_MIGRATIONS.length, {
    id: 'recomputeAliasedTopicKeys',
    kind: 'convergent',
    background: true,
    run,
  });
}
const start = () =>
  (stop = migrations.startBackgroundDataMigrations(db, {
    deadlineMs: 20,
    initialDelayMs: 10,
    maxDelayMs: 25,
  }));

describe('global KB boot repair', () => {
  it('finishes boot migrations without awaiting either stalled global-store migration', async () => {
    const stalled = vi.fn(() => new Promise<void>(() => {}));
    migrations.DATA_MIGRATIONS.splice(
      0,
      migrations.DATA_MIGRATIONS.length,
      ...original
        .filter((m) =>
          ['recomputeAliasedTopicKeys', 'classifyGlobalKbVectorProvenance'].includes(m.id),
        )
        .map((m) => ({ ...m, run: stalled })),
    );
    let complete = false;
    void migrations.runDataMigrations(db).then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBe(true);
    expect(stalled).not.toHaveBeenCalled();
  });

  it('bounds stalled attempts, warns once each, backs off to a cap, and stops after success', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let active = 0;
    let peak = 0;
    const run = vi.fn<migrations.DataMigration['run']>(async (_db, opts) => {
      active++;
      peak = Math.max(peak, active);
      try {
        if (run.mock.calls.length < 4)
          await new Promise<void>((_resolve, reject) => {
            opts!.signal!.addEventListener('abort', () => reject(opts!.signal!.reason), {
              once: true,
            });
          });
      } finally {
        active--;
      }
    });
    install(run);
    const firstStop = start();
    expect(migrations.startBackgroundDataMigrations(db)).toBe(firstStop);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attempt: 1,
        delayMs: 10,
        err: expect.objectContaining({ code: 'GLOBAL_KB_DEADLINE' }),
      }),
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(10 + 20);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 2, delayMs: 20 }),
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(20 + 20);
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 3, delayMs: 25 }),
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(25);
    expect(run).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('cancels an active attempt cleanly and removes every timer on shutdown', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    const run = vi.fn<migrations.DataMigration['run']>(async (_db, opts) => {
      signal = opts!.signal;
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
      );
    });
    install(run);
    start();
    await vi.advanceTimersByTimeAsync(0);
    stop!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal!.aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an unreferenced retry timer when stopped between attempts', async () => {
    install(async () => {
      throw new Error('store unavailable');
    });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    start();
    await vi.advanceTimersByTimeAsync(0);
    const retry = timer.mock.results.at(-1)!.value as NodeJS.Timeout;
    expect(retry.hasRef()).toBe(false);
    stop!();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pins the production deadline and backoff bounds', () => {
    expect(migrations.BACKGROUND_MIGRATION_DEADLINE_MS).toBe(60_000);
    expect(migrations.BACKGROUND_MIGRATION_INITIAL_DELAY_MS).toBe(1000);
    expect(migrations.BACKGROUND_MIGRATION_MAX_DELAY_MS).toBe(60_000);
  });
});

describe('alias key repair while jobs are admitted', () => {
  const recompute = original.find((m) => m.id === 'recomputeAliasedTopicKeys')!.run;
  const setup = () => {
    const fake = createFakeDb({ globalKbEntries });
    h.kb = fake.db;
    fake.insert(globalKbEntries, {
      id: '00000000-0000-4000-8000-000000000001',
      category: 'best_practice',
      facets: { database: ['postgres'], dbMajor: ['15'] },
      topicKey: 'best_practice:postgresql:15',
    });
    return fake;
  };

  it('converges aliases after the ensure, preserves other keys, and is idempotent', async () => {
    const fake = setup();
    for (const [i, key] of [
      'best_practice:custom:15',
      'best_practice:postgresql:14',
      null,
    ].entries()) {
      fake.insert(globalKbEntries, {
        id: `00000000-0000-4000-8000-00000000000${i + 2}`,
        category: 'best_practice',
        facets: { database: ['postgres'], dbMajor: ['15'] },
        topicKey: key,
      });
    }
    const update = vi.fn();
    fake.hooks.beforeUpdate = update;
    await recompute(db);
    await recompute(db);
    expect(fake.rows(globalKbEntries).map((r) => r.topicKey)).toEqual([
      'best_practice:postgres:15',
      'best_practice:custom:15',
      'best_practice:postgresql:14',
      null,
    ]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('leaves an entry edited after the scan alone', async () => {
    const fake = setup();
    fake.hooks.beforeUpdate = () => {
      fake.patch(globalKbEntries, '00000000-0000-4000-8000-000000000001', {
        facets: { database: ['redis'] },
        topicKey: 'best_practice:redis',
      });
    };
    await recompute(db);
    expect(fake.rows(globalKbEntries)[0]!.topicKey).toBe('best_practice:redis');
  });
});
