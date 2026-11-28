import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { type AliasRepository } from '../src/repo/worktree-alias-background.js';
import { type AliasRetry } from '../src/repo/worktree-alias-sweep.js';
import {
  WorktreeAliasSweeper,
  WORKTREE_ALIAS_BATCH_MS,
} from '../src/repo/worktree-alias-background.js';

// Step-count assertions must not depend on how long the host takes between operations.
const maxBatchMs = Number.POSITIVE_INFINITY;

describe('worktree alias background batches', () => {
  it('bounds work per tick, records only completion, and retries an ambiguous completion after restart', async () => {
    const repo = { id: 'r', anchor: '/owned' };
    const next = vi.fn().mockResolvedValue(repo);
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValue(true);
    const walk = vi.fn(async function* () {
      yield { examined: 1, replaced: 0 };
      yield { examined: 2, replaced: 1 };
    });
    const worker = new WorktreeAliasSweeper({ next, complete }, { walk, maxSteps: 1, maxBatchMs });
    await worker.tick();
    expect(complete).not.toHaveBeenCalled();
    await worker.tick();
    expect(complete).not.toHaveBeenCalled();
    await worker.tick();
    expect(complete).toHaveBeenCalledTimes(1);
    await worker.stop();
    const restarted = new WorktreeAliasSweeper(
      { next, complete },
      { walk, maxSteps: 8, maxBatchMs },
    );
    await restarted.tick();
    expect(complete).toHaveBeenCalledTimes(2); // Copies share the batch while time remains.
    expect(walk).toHaveBeenCalledTimes(2);
    await restarted.stop();
  });
  it('does not certify a failed scan, advances past it, serializes ticks and closes on stop', async () => {
    const next = vi.fn().mockResolvedValue({ id: 'a', anchor: '/owned' });
    const complete = vi.fn();
    const close = vi.fn();
    const walk = async function* () {
      try {
        yield { examined: 1, replaced: 0 };
        throw new Error('unreadable');
      } finally {
        close();
      }
    };
    const worker = new WorktreeAliasSweeper({ next, complete }, { walk, maxSteps: 1, maxBatchMs });
    await Promise.all([worker.tick(), worker.tick()]);
    expect(next).toHaveBeenCalledTimes(1);
    await worker.tick();
    expect(complete).not.toHaveBeenCalled();
    await worker.tick();
    expect(next).toHaveBeenLastCalledWith('a');
    await worker.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
it('M1 persists exponential capped backoff across replacement, with one warning per streak', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const repo = {
    id: 'r',
    anchor: '/owned',
    retry: undefined as { attempts: number; retryAt: number } | undefined,
  };
  const fail = vi.fn(async (_repo: AliasRepository, retry: AliasRetry) => {
    repo.retry = retry;
  });
  const walk = vi.fn(async function* () {
    throw new Error('unreadable');
  });
  const store = { next: vi.fn(async () => repo), complete: vi.fn(), fail };
  const first = new WorktreeAliasSweeper(store, { walk });
  await first.tick();
  expect(fail).toHaveBeenCalledTimes(1);
  const retryAt = repo.retry!.retryAt;
  expect(retryAt).toBeGreaterThan(now);
  await first.stop();
  const restarted = new WorktreeAliasSweeper(store, { walk });
  await restarted.tick();
  expect(walk).toHaveBeenCalledTimes(1);
  now = retryAt;
  await restarted.tick();
  expect(walk).toHaveBeenCalledTimes(2);
  expect(repo.retry!.retryAt - now).toBe(2 * (retryAt - 1000));
  expect(warn).toHaveBeenCalledTimes(1);
  await restarted.stop();
});
it('M6 checkpoints progress yielded before a repository fault and never resets it', async () => {
  const scan = { cursor: '.haive/worktrees/task/a', examined: 2, complete: false };
  const checkpoint = vi.fn();
  const reset = vi.fn();
  const walk = async function* () {
    yield { examined: 2, replaced: 0, scan };
    throw new Error('repository failure');
  };
  const repo = { id: 'r', anchor: '/owned' };
  const store = { next: vi.fn(async () => repo), complete: vi.fn(), checkpoint, reset };
  const worker = new WorktreeAliasSweeper(store, { walk, maxBatchMs });
  await worker.tick();
  expect(checkpoint).toHaveBeenCalledWith(repo, scan, []);
  expect(reset).not.toHaveBeenCalled();
  await worker.stop();
});
it('M1 caps retry delay, and polls an empty install only at the idle cadence', async () => {
  const { aliasRetry, WORKTREE_ALIAS_RETRY_MAX_MS, WORKTREE_ALIAS_IDLE_MS } =
    await import('../src/repo/worktree-alias-background.js');
  expect(WORKTREE_ALIAS_RETRY_MAX_MS).toBe(6 * 60 * 60 * 1000);
  expect(aliasRetry(31, 100).retryAt).toBe(100 + WORKTREE_ALIAS_RETRY_MAX_MS);
  let now = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const next = vi.fn(async () => null);
  const worker = new WorktreeAliasSweeper({ next, complete: vi.fn() });
  await worker.tick();
  await worker.tick();
  expect(next).toHaveBeenCalledTimes(1);
  now += WORKTREE_ALIAS_IDLE_MS;
  await worker.tick();
  expect(next).toHaveBeenCalledTimes(2);
  await worker.stop();
});

it('L-c batches multiple replacements up to the time cap', async () => {
  expect(WORKTREE_ALIAS_BATCH_MS).toBe(100);
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const complete = vi.fn(async () => true);
  const walk = async function* () {
    for (let n = 1; n <= 6; n++) {
      now += 30;
      yield { examined: n, replaced: n };
    }
  };
  const worker = new WorktreeAliasSweeper(
    { next: async () => ({ id: 'r', anchor: '/owned' }), complete },
    { walk, maxSteps: 8, maxBatchMs: 100 },
  );
  await worker.tick();
  expect(now).toBe(120); // The deadline ends the tick after four copies, before maxSteps.
  expect(complete).not.toHaveBeenCalled();
  await worker.tick();
  expect(now).toBe(180);
  expect(complete).toHaveBeenCalledOnce();
  await worker.stop();
});
it.each([
  [{ vanished: 2, changed_entry: 1 }, false],
  [{ oversized_file: 1, vanished: 2 }, true],
  [{ foreign_park: 1 }, true],
  [{ non_utf8_name: 1 }, true],
  [{ pass_limit: 1 }, true],
  [{ source_changed: 1 }, true],
])('L-d reports counted skips at the appropriate severity (%j)', async (skipped, exposure) => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const walk = async function* () {
    yield { examined: 1, replaced: 0, skipped };
  };
  const worker = new WorktreeAliasSweeper(
    { next: async () => ({ id: 'r', anchor: '/owned' }), complete: async () => true },
    { walk, maxBatchMs },
  );
  await worker.tick();
  expect(exposure ? warn : info).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'done-with-skips', skipped }),
    'legacy worktree alias sweep completed',
  );
  expect(exposure ? info : warn).not.toHaveBeenCalled();
  await worker.stop();
});
it.each(['ENOSPC', 'EIO'])(
  'retains escalating %s backoff across multi-batch rediscovery and restart',
  async (code) => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const repo: AliasRepository = { id: 'r', anchor: '/owned' };
    const fail = vi.fn(async (_repo: AliasRepository, retry: AliasRetry) => {
      repo.retry = retry;
    });
    const complete = vi.fn(async () => true);
    let failing = true;
    const walk = async function* () {
      for (let n = 1; n <= 3; n++)
        yield {
          examined: n,
          replaced: 0,
          scan: { cursor: `.haive/worktrees/task/${n}`, examined: n, complete: n === 3 },
        };
      if (failing) throw Object.assign(new Error('persistent copy failure'), { code });
    };
    const store = { next: async () => repo, complete, fail, checkpoint: vi.fn() };
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Recreate the worker to prove persisted escalation as well as batch boundaries.
      const worker = new WorktreeAliasSweeper(store, { walk, maxSteps: 1 });
      for (let tick = 0; tick < 4; tick++) await worker.tick();
      expect(repo.retry).toEqual({ attempts: attempt, retryAt: now + 60_000 * 2 ** (attempt - 1) });
      now = repo.retry!.retryAt;
      await worker.stop();
    }
    expect(fail.mock.calls.map(([, retry]) => retry.attempts)).toEqual([1, 2, 3]);
    expect(warn).toHaveBeenCalledOnce();
    failing = false;
    const recovered = new WorktreeAliasSweeper(store, { walk, maxSteps: 8 });
    await recovered.tick();
    expect(complete).toHaveBeenCalledOnce();
    await recovered.stop();
  },
);

it('L-e retains escalation when a faulted batch only repeats discovery before the same copy failure', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const repo = { id: 'r', anchor: '/owned', retry: { attempts: 3, retryAt: 1_000_000 } };
  const fail = vi.fn(async () => undefined);
  const walk = async function* () {
    yield {
      examined: 1,
      replaced: 0,
      scan: { cursor: '.haive/worktrees/task/f', examined: 1, complete: true },
    };
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  const worker = new WorktreeAliasSweeper(
    { next: async () => repo, complete: vi.fn(), fail },
    { walk },
  );
  await worker.tick();
  expect(fail).toHaveBeenCalledWith(repo, { attempts: 4, retryAt: 1_480_000 });
  await worker.stop();
});
