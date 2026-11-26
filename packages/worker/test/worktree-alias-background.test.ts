import { describe, expect, it, vi } from 'vitest';
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
    expect(close).toHaveBeenCalledTimes(2);
  });
});
