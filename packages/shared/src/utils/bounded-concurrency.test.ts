import { describe, it, expect } from 'vitest';
import { createBoundedConcurrency, mapWithConcurrency } from './bounded-concurrency.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createBoundedConcurrency', () => {
  it('never exceeds the limit in flight', async () => {
    const limiter = createBoundedConcurrency(2);
    let active = 0;
    let maxActive = 0;
    const run = () =>
      limiter.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active -= 1;
      });
    await Promise.all(Array.from({ length: 10 }, run));
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('clamps a limit below 1 to serial', async () => {
    const limiter = createBoundedConcurrency(0);
    let active = 0;
    let maxActive = 0;
    const run = () =>
      limiter.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(2);
        active -= 1;
      });
    await Promise.all(Array.from({ length: 5 }, run));
    expect(maxActive).toBe(1);
  });

  it('runs queued tasks in FIFO submission order', async () => {
    const limiter = createBoundedConcurrency(1);
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        limiter.run(async () => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in results regardless of settle order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await sleep((5 - n) * 3);
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('bounds concurrency to the cap', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(4);
        active -= 1;
      },
    );
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 3, async (x) => x)).toEqual([]);
  });

  it('rejects on the first task rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});
