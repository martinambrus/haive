import type { Redis } from 'ioredis';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acquireRagSyncLock,
  tryAcquireRagSyncLock,
  RagSyncLockAbortedError,
  RagSyncLockTimeoutError,
} from '../src/rag/sync-lock.js';
const outage = Object.assign(new Error('transport failed'), { code: 'redis_unavailable' });
const redisWith = (set: unknown) => ({ set, eval: async () => 1 }) as unknown as Redis;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('polls a coded unavailable attempt and acquires only after recovery', async () => {
  const set = vi.fn().mockRejectedValueOnce(outage).mockResolvedValue('OK');
  const waiting = acquireRagSyncLock(redisWith(set), 'repo', { waitMs: 100, pollMs: 10 });
  const result = waiting.then(
    (held) => ({ held }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(9);
  expect(set).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  const got = await result;
  expect(got).toHaveProperty('held');
  expect(set).toHaveBeenCalledTimes(2);
  if ('held' in got) await got.held.release();
});
it('keeps the overall wait bound during coded outages', async () => {
  const set = vi.fn().mockRejectedValue(outage);
  const result = acquireRagSyncLock(redisWith(set), 'repo', { waitMs: 20, pollMs: 10 }).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toBeInstanceOf(RagSyncLockTimeoutError);
  expect(set).toHaveBeenCalledTimes(3);
});
it('aborts the outage poll without another attempt', async () => {
  const set = vi.fn().mockRejectedValue(outage);
  const ac = new AbortController();
  const result = acquireRagSyncLock(redisWith(set), 'repo', {
    waitMs: 100,
    pollMs: 50,
    signal: ac.signal,
  }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  ac.abort();
  expect(await result).toBeInstanceOf(RagSyncLockAbortedError);
  expect(set).toHaveBeenCalledTimes(1);
});
it('still propagates server failures and one-shot acquire outages', async () => {
  const wrongType = Object.assign(new Error('server error'), { code: 'WRONGTYPE' });
  await expect(
    acquireRagSyncLock(redisWith(vi.fn().mockRejectedValue(wrongType)), 'repo', { waitMs: 100 }),
  ).rejects.toBe(wrongType);
  await expect(
    tryAcquireRagSyncLock(redisWith(vi.fn().mockRejectedValue(outage)), 'repo'),
  ).rejects.toBe(outage);
});

it('reports unreadable attempts separately from another holder', async () => {
  const onWait = vi.fn();
  const set = vi
    .fn()
    .mockRejectedValueOnce(outage)
    .mockResolvedValueOnce(null)
    .mockResolvedValue('OK');
  const waiting = acquireRagSyncLock(redisWith(set), 'repo', { waitMs: 100, pollMs: 10, onWait });
  await vi.advanceTimersByTimeAsync(0);
  expect(onWait).toHaveBeenLastCalledWith('redis_unavailable');
  await vi.advanceTimersByTimeAsync(10);
  expect(onWait).toHaveBeenLastCalledWith('held');
  await vi.advanceTimersByTimeAsync(10);
  await (await waiting).release();
});
