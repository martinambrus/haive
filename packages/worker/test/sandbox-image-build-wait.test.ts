import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { waitForInFlightBuild } from '../src/queues/cli-exec-queue.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

type ProviderRow = {
  sandboxImageBuildStatus: 'idle' | 'building' | 'ready' | 'failed';
  sandboxImageBuildError: string | null;
};

/** Each entry answers one poll; the last one repeats so a test only spells out the
 *  transitions it cares about. */
function makeDb(rows: (ProviderRow | undefined)[]): { db: Database; calls: () => number } {
  let i = 0;
  const db = {
    query: {
      cliProviders: {
        findFirst: async () => {
          const row = rows[Math.min(i, rows.length - 1)];
          i += 1;
          return row;
        },
      },
    },
  } as unknown as Database;
  return { db, calls: () => i };
}

function makeRunner(existsPerCall: boolean[]): {
  runner: DockerRunner;
  calls: () => number;
} {
  let i = 0;
  const runner: DockerRunner = {
    build: async () => {
      throw new Error('build should not be called');
    },
    run: async () => {
      throw new Error('run should not be called');
    },
    inspect: async () => {
      const exists = existsPerCall[Math.min(i, existsPerCall.length - 1)] ?? false;
      i += 1;
      return { exists, imageId: exists ? 'sha256:abc' : null };
    },
    remove: async () => ({ ok: true, stderr: '' }),
    volumeCreate: async () => ({ ok: true, stderr: '' }),
    volumeExists: async () => false,
    volumeRemove: async () => ({ ok: true, stderr: '' }),
  };
  return { runner, calls: () => i };
}

const BUILDING: ProviderRow = { sandboxImageBuildStatus: 'building', sandboxImageBuildError: null };
const TAG = 'haive-cli-sandbox:codex-0.153.0-abc';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('waitForInFlightBuild', () => {
  it('a zero budget answers immediately and touches neither docker nor the db', async () => {
    const { db, calls: dbCalls } = makeDb([BUILDING]);
    const { runner, calls: inspectCalls } = makeRunner([false]);

    await expect(waitForInFlightBuild(db, 'p1', TAG, 0, runner)).resolves.toEqual({
      done: 'timeout',
    });
    // The interactive probe depends on this: it must report "build in progress" now,
    // not spin for minutes behind a background rebuild.
    expect(dbCalls()).toBe(0);
    expect(inspectCalls()).toBe(0);
  });

  it('returns image_ready once the image lands, which is the plan_build regression', async () => {
    // Image absent on the first poll (build still running), present on the second.
    const { db } = makeDb([BUILDING]);
    const { runner } = makeRunner([false, true]);

    const pending = waitForInFlightBuild(db, 'p1', TAG, 60_000, runner);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toEqual({ done: 'image_ready' });
  });

  it('a present image wins over a row that still reads building', async () => {
    // The builder commits the layer before it updates the row; the image is definitive.
    const { db, calls: dbCalls } = makeDb([BUILDING]);
    const { runner } = makeRunner([true]);

    const pending = waitForInFlightBuild(db, 'p1', TAG, 60_000, runner);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual({ done: 'image_ready' });
    expect(dbCalls()).toBe(0);
  });

  it('surfaces a failed build instead of waiting out the budget', async () => {
    const { db } = makeDb([
      { sandboxImageBuildStatus: 'failed', sandboxImageBuildError: 'npm 404' },
    ]);
    const { runner } = makeRunner([false]);

    const pending = waitForInFlightBuild(db, 'p1', TAG, 60_000, runner);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual({ done: 'build_failed', error: 'npm 404' });
  });

  it('reports not_building when the builder left without an image', async () => {
    const { db } = makeDb([{ sandboxImageBuildStatus: 'idle', sandboxImageBuildError: null }]);
    const { runner } = makeRunner([false]);

    const pending = waitForInFlightBuild(db, 'p1', TAG, 60_000, runner);
    await vi.advanceTimersByTimeAsync(3_000);

    // Caller falls through and builds rather than failing on a lock nobody holds.
    await expect(pending).resolves.toEqual({ done: 'not_building' });
  });

  it('reports not_building when the provider row vanished mid-wait', async () => {
    const { db } = makeDb([undefined]);
    const { runner } = makeRunner([false]);

    const pending = waitForInFlightBuild(db, 'p1', TAG, 60_000, runner);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual({ done: 'not_building' });
  });

  it('gives up on a stale building row rather than hanging a fan-out forever', async () => {
    const { db } = makeDb([BUILDING]);
    const { runner } = makeRunner([false]);

    const pending = waitForInFlightBuild(db, 'p1', TAG, 6_000, runner);
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toEqual({ done: 'timeout' });
  });
});
