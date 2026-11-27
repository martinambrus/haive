import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  entries: [] as string[],
  chunk: Promise.resolve(),
  exit: Promise.resolve('1-0'),
}));
vi.mock('../src/redis.js', () => ({
  getRedis: () => ({
    multi: () => {
      const chain = {
        xadd: () => chain,
        expire: () => chain,
        exec: async () => {
          await h.chunk;
          h.entries.push('chunk');
          return [];
        },
      };
      return chain;
    },
  }),
  getPatientRedis: () => ({
    xadd: async () => {
      await h.exit;
      h.entries.push('exit');
      return '1-0';
    },
    expire: async () => 1,
  }),
}));
import {
  CLI_EXIT_WAIT_MS,
  publishCliChunk,
  publishCliExit,
} from '../src/queues/cli-stream-publisher.js';
beforeEach(() => {
  vi.useFakeTimers();
  h.entries = [];
  h.chunk = Promise.resolve();
  h.exit = Promise.resolve('1-0');
});
afterEach(() => vi.useRealTimers());
it('writes the exit after a delayed final chunk from the other connection', async () => {
  let finish!: () => void;
  h.chunk = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const chunk = publishCliChunk('ordered', 'stdout', 'last');
  const exit = publishCliExit('ordered', 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.entries).toEqual([]);
  finish();
  await Promise.all([chunk, exit]);
  expect(h.entries).toEqual(['chunk', 'exit']);
});
it('pins the production exit bound', () => {
  expect(CLI_EXIT_WAIT_MS).toBe(5_000);
});
it('bounds an exit write so DB finalization can proceed during an outage', async () => {
  let finish!: (id: string) => void;
  h.exit = new Promise<string>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const exit = publishCliExit('bounded', 0, { waitMs: 20 }).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(19);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  finish('1-0');
  await exit;
});

it('drops an exit whose drain expires instead of sending it ahead of chunks', async () => {
  let finish!: () => void;
  h.chunk = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const chunk = publishCliChunk('drain-bound', 'stdout', 'last');
  const exit = publishCliExit('drain-bound', 0, { waitMs: 20 });
  await vi.advanceTimersByTimeAsync(20);
  await exit;
  expect(h.entries).toEqual([]);
  finish();
  await chunk;
  await vi.advanceTimersByTimeAsync(0);
  expect(h.entries).toEqual(['chunk']);
});
