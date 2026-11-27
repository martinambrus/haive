import type { Database } from '@haive/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acquireAgentLease,
  AgentLeaseAbortedError,
  AgentLeaseTimeoutError,
  reserveAgentSlot,
} from '../src/queues/cli-exec/agent-lease.js';
const h = vi.hoisted(() => ({ eval: vi.fn(), hdel: vi.fn(async () => 1) }));
vi.mock('../src/redis.js', () => ({ getRedis: () => h }));
const outage = Object.assign(new Error('transport failed'), { code: 'redis_unavailable' });
const deps = { db: {} as Database, agentCap: async () => 2 };
beforeEach(() => {
  vi.useFakeTimers();
  h.eval.mockReset();
});
afterEach(() => vi.useRealTimers());
it('polls a coded outage before taking a step-command lease', async () => {
  h.eval.mockRejectedValueOnce(outage).mockResolvedValue([1, 1]);
  const result = acquireAgentLease(deps, { waitMs: 100, pollMs: 10 }).then(
    (lease) => ({ lease }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(10);
  const got = await result;
  expect(got).toHaveProperty('lease');
  expect(h.eval).toHaveBeenCalledTimes(2);
  if ('lease' in got) await got.lease.release();
});
it('ends an outage poll at its wait bound', async () => {
  h.eval.mockRejectedValue(outage);
  const result = acquireAgentLease(deps, { waitMs: 20, pollMs: 10 }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toBeInstanceOf(AgentLeaseTimeoutError);
});
it('aborts an outage poll without another attempt', async () => {
  h.eval.mockRejectedValue(outage);
  const ac = new AbortController();
  const result = acquireAgentLease(deps, { waitMs: 100, pollMs: 50, signal: ac.signal }).catch(
    (error) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  ac.abort();
  expect(await result).toBeInstanceOf(AgentLeaseAbortedError);
  expect(h.eval).toHaveBeenCalledTimes(1);
});
it('keeps one-shot INVOKE failures and unrelated errors visible', async () => {
  h.eval.mockRejectedValue(outage);
  await expect(reserveAgentSlot('invoke:x', 2)).rejects.toBe(outage);
  const error = new Error('not an outage');
  h.eval.mockRejectedValue(error);
  await expect(acquireAgentLease(deps)).rejects.toBe(error);
});

it('reuses one field when muted EVAL replies hide reservations that landed', async () => {
  h.eval.mockRejectedValueOnce(outage).mockRejectedValueOnce(outage).mockResolvedValue([1, 1]);
  const waiting = acquireAgentLease(deps, { waitMs: 100, pollMs: 10 });
  await vi.advanceTimersByTimeAsync(20);
  const lease = await waiting;
  const fields = h.eval.mock.calls.map((args) => args[5]);
  expect(fields).toHaveLength(3);
  expect(new Set(fields).size).toBe(1);
  expect(fields[0]).toBe(`lease:${lease.id}`);
  await lease.release();
});
it('reports an outage distinctly from an occupied pool, and clears it on recovery', async () => {
  const onWait = vi.fn();
  h.eval.mockRejectedValueOnce(outage).mockResolvedValueOnce([0, 2]).mockResolvedValue([1, 1]);
  const waiting = acquireAgentLease(deps, { waitMs: 100, pollMs: 10, onWait });
  await vi.advanceTimersByTimeAsync(0);
  expect(onWait).toHaveBeenLastCalledWith(0, 2, 'redis_unavailable');
  await vi.advanceTimersByTimeAsync(10);
  expect(onWait).toHaveBeenLastCalledWith(2, 2);
  await vi.advanceTimersByTimeAsync(10);
  await (await waiting).release();
});
