import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@haive/shared', () => ({ logger: { child: () => log } }));

import { pruneJobSchedulers } from '../src/queues/job-scheduler-prune.js';

function fakeQueue(ids: string[], gone: string[] = []) {
  const live = new Set(ids);
  const removed: string[] = [];
  const ranges: Array<[number, number]> = [];
  return {
    name: 'haive-fake',
    live,
    removed,
    ranges,
    getJobSchedulersCount: async () => live.size,
    getJobSchedulers: async (start = 0, end = -1) => {
      ranges.push([start, end]);
      return [...live]
        .slice(start, end < 0 ? undefined : end + 1)
        .map((key) => ({ key, name: 'tick' }));
    },
    removeJobScheduler: async (id: string) => {
      removed.push(id);
      return live.delete(id) && !gone.includes(id);
    },
  };
}

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
});

describe('pruneJobSchedulers', () => {
  it('removes exactly the ids outside keep and returns that count', async () => {
    const queue = fakeQueue(['owned', 'a', 'b', 'c']);
    expect(await pruneJobSchedulers(queue, ['owned'])).toBe(3);
    expect(queue.removed.sort()).toEqual(['a', 'b', 'c']);
    expect([...queue.live]).toEqual(['owned']);
  });

  it('removes nothing on a second run', async () => {
    const queue = fakeQueue(['owned', 'a', 'b']);
    await pruneJobSchedulers(queue, ['owned']);
    expect(await pruneJobSchedulers(queue, ['owned'])).toBe(0);
    expect(queue.removed).toEqual(['a', 'b']);
  });

  it('never removes an id in keep, listed or not', async () => {
    const queue = fakeQueue(['one', 'two', 'x']);
    expect(await pruneJobSchedulers(queue, ['one', 'two', 'absent'])).toBe(1);
    expect(queue.removed).toEqual(['x']);
    expect(queue.removed).not.toContain('one');
    expect(queue.removed).not.toContain('two');
  });

  it('clears the 343 legacy ids of the dev install through bounded pages', async () => {
    const legacy = Array.from({ length: 343 }, (_, i) => `legacy-${i}`);
    const queue = fakeQueue(['owned', ...legacy]);
    expect(await pruneJobSchedulers(queue, ['owned'])).toBe(343);
    expect([...queue.live]).toEqual(['owned']);
    expect(queue.ranges.length).toBeGreaterThan(1);
    expect(queue.ranges.every(([start, end]) => end >= start)).toBe(true);
  });

  it('counts only the schedulers it actually removed', async () => {
    const queue = fakeQueue(['owned', 'a', 'b'], ['a']);
    expect(await pruneJobSchedulers(queue, ['owned'])).toBe(1);
  });

  it('logs one info line when it removed something and none otherwise', async () => {
    await pruneJobSchedulers(fakeQueue(['owned', 'a', 'b']), ['owned']);
    expect(log.info).toHaveBeenCalledTimes(1);
    log.info.mockClear();
    await pruneJobSchedulers(fakeQueue(['owned']), ['owned']);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the listing fails', async () => {
    const queue = fakeQueue(['owned', 'a']);
    queue.getJobSchedulers = async () => {
      throw new Error('listing failed');
    };
    expect(await pruneJobSchedulers(queue, ['owned'])).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(queue.removed).toEqual([]);
  });

  it('warns and reports what it removed when a removal fails part way', async () => {
    const queue = fakeQueue(['owned', 'a', 'b']);
    const remove = queue.removeJobScheduler;
    queue.removeJobScheduler = async (id: string) => {
      if (id === 'b') throw new Error('removal failed');
      return remove(id);
    };
    expect(await pruneJobSchedulers(queue, ['owned'])).toBe(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
