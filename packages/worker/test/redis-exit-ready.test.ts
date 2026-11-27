import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { publishCliExit } from '../src/queues/cli-stream-publisher.js';
import { closeRedis, getPatientRedis, initRedis } from '../src/redis.js';
import { startFake, type Fake } from './support/redis-stall.js';
let fake: Fake | undefined;
afterEach(async () => {
  if (fake) fake.loading = false;
  const closing = closeRedis();
  await vi.advanceTimersByTimeAsync(1000);
  await closing;
  await fake?.stop();
  vi.useRealTimers();
});
it('delivers the exit frame and its TTL after a LOADING outage', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fake = await startFake();
  fake.loading = true;
  const info = fake.nextCommand('INFO');
  initRedis(`redis://127.0.0.1:${fake.port}`, { commandTimeoutMs: 25 }).bullRedis.on(
    'error',
    () => undefined,
  );
  await info;
  let settled = false;
  const exit = publishCliExit('inv', 0).then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(1200);
  expect(settled).toBe(false);
  fake.loading = false;
  const ready = once(getPatientRedis(), 'ready');
  await vi.advanceTimersByTimeAsync(1000);
  await ready;
  await exit;
  expect(fake.commands.filter((c) => c[0]!.toUpperCase() === 'XADD')).toEqual([
    ['xadd', 'cli-stream:inv', '*', 'stream', 'exit', 'code', '0'],
  ]);
  expect(fake.commands.filter((c) => c[0]!.toUpperCase() === 'EXPIRE')).toEqual([
    ['expire', 'cli-stream:inv', '600'],
  ]);
});
