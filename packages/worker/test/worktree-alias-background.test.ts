import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { type AliasRepository } from '../src/repo/worktree-alias-background.js';
import { type AliasRetry } from '../src/repo/worktree-alias-sweep.js';
import { WorktreeAliasSweeper } from '../src/repo/worktree-alias-background.js';

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
    const worker = new WorktreeAliasSweeper({ next, complete }, { walk, maxSteps: 1 });
    await worker.tick();
    expect(complete).not.toHaveBeenCalled();
    await worker.tick();
    expect(complete).not.toHaveBeenCalled();
    await worker.tick();
    expect(complete).toHaveBeenCalledTimes(1);
    await worker.stop();
    const restarted = new WorktreeAliasSweeper({ next, complete }, { walk, maxSteps: 8 });
    await restarted.tick();
    expect(complete).toHaveBeenCalledTimes(1); // A batch stops after its first copy.
    await restarted.tick();
    expect(complete).toHaveBeenCalledTimes(2);
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
    const worker = new WorktreeAliasSweeper({ next, complete }, { walk, maxSteps: 1 });
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
  const worker = new WorktreeAliasSweeper(store, { walk });
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
