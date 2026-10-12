import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  RagSyncLockAbortedError,
  RagSyncLockCommandTimeoutError,
  RagSyncLockLostError,
  RagSyncLockTimeoutError,
  acquireRagSyncLock,
  fenceRagStore,
  tryAcquireRagSyncLock,
} from '../src/rag/sync-lock.js';

const never = () => new Promise<never>(() => undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const asRedis = (fake: object) => fake as unknown as Redis;

describe('RAG sync lock against a Redis that does not answer', () => {
  it('rejects tryAcquire within the command timeout', async () => {
    const redis = asRedis({ set: never, eval: never });
    const startedAt = Date.now();
    await expect(tryAcquireRagSyncLock(redis, 'repo', { commandTimeoutMs: 50 })).rejects.toThrow(
      RagSyncLockCommandTimeoutError,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }, 3_000);

  it('still aborts a waiting acquire on the signal', async () => {
    const redis = asRedis({ set: never, eval: never });
    const controller = new AbortController();
    const waiting = acquireRagSyncLock(redis, 'repo', {
      waitMs: 60_000,
      commandTimeoutMs: 30_000,
      signal: controller.signal,
    });
    const settled = expect(waiting).rejects.toThrow(RagSyncLockAbortedError);
    setTimeout(() => controller.abort(), 50);
    await settled;
  }, 3_000);

  it('retries a timed-out attempt and ends at the wait bound', async () => {
    const set = vi.fn(never);
    const redis = asRedis({ set, eval: never });
    await expect(
      acquireRagSyncLock(redis, 'repo', { waitMs: 300, pollMs: 20, commandTimeoutMs: 40 }),
    ).rejects.toThrow(RagSyncLockTimeoutError);
    expect(set.mock.calls.length).toBeGreaterThan(1);
  }, 3_000);

  it('takes the lock once Redis answers again', async () => {
    let calls = 0;
    const set = vi.fn(() => (++calls < 3 ? never() : Promise.resolve('OK')));
    const redis = asRedis({ set, eval: () => Promise.resolve(1) });
    const held = await acquireRagSyncLock(redis, 'repo', {
      waitMs: 5_000,
      pollMs: 10,
      commandTimeoutMs: 30,
      heartbeatMs: 60_000,
    });
    expect(held.lost).toBe(false);
    await held.release();
  }, 3_000);

  it('releases a key a timed-out SET sets after all', async () => {
    let answer!: (value: string) => void;
    const set = vi.fn(
      (..._args: unknown[]) => new Promise<string>((resolve) => (answer = resolve)),
    );
    const evalCalls: unknown[][] = [];
    const redis = asRedis({
      set,
      eval: (...args: unknown[]) => {
        evalCalls.push(args);
        return Promise.resolve(1);
      },
    });
    await expect(tryAcquireRagSyncLock(redis, 'repo', { commandTimeoutMs: 30 })).rejects.toThrow(
      RagSyncLockCommandTimeoutError,
    );
    answer('OK');
    await sleep(20);
    expect(evalCalls).toHaveLength(1);
    expect(evalCalls[0]![3]).toBe(set.mock.calls[0]![1]);
  }, 3_000);

  it('does not mark a holder lost when a refresh gets no answer, and releases within the timeout', async () => {
    const redis = asRedis({ set: () => Promise.resolve('OK'), eval: never });
    const held = await tryAcquireRagSyncLock(redis, 'repo', {
      heartbeatMs: 20,
      commandTimeoutMs: 30,
    });
    await sleep(200);
    expect(held!.lost).toBe(false);
    const startedAt = Date.now();
    await held!.release();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  }, 3_000);

  it('counts a holder lost once no refresh has been confirmed for a whole TTL', async () => {
    const redis = asRedis({ set: () => Promise.resolve('OK'), eval: never });
    const held = await tryAcquireRagSyncLock(redis, 'repo', {
      ttlMs: 100,
      heartbeatMs: 20,
      commandTimeoutMs: 30,
    });
    expect(held!.lost).toBe(false);
    await sleep(200);
    expect(held!.lost).toBe(true);
    expect(() => held!.assertHeld()).toThrow(RagSyncLockLostError);
    await held!.release();
  }, 3_000);

  it('keeps a holder whose refreshes are confirmed past its first TTL', async () => {
    const redis = asRedis({ set: () => Promise.resolve('OK'), eval: () => Promise.resolve(1) });
    const held = await tryAcquireRagSyncLock(redis, 'repo', { ttlMs: 100, heartbeatMs: 20 });
    await sleep(300);
    expect(held!.lost).toBe(false);
    await held!.release();
  }, 3_000);

  it('marks a holder lost when a refresh answers that the key is not its own', async () => {
    const redis = asRedis({ set: () => Promise.resolve('OK'), eval: () => Promise.resolve(0) });
    const held = await tryAcquireRagSyncLock(redis, 'repo', { heartbeatMs: 20 });
    await sleep(100);
    expect(held!.lost).toBe(true);
    await held!.release();
  }, 3_000);
});

describe('a RAG store fenced by its sync lock', () => {
  const lockWith = (state: { lost: boolean }) => ({
    get lost() {
      return state.lost;
    },
    assertHeld: () => {
      if (state.lost) throw new RagSyncLockLostError();
    },
    release: async () => undefined,
  });

  it('sends statements while the lock is held and none once it is lost', async () => {
    const sent: unknown[][] = [];
    const conn = {
      mode: 'external',
      pg: {
        unsafe: (...args: unknown[]) => (sent.push(args), Promise.resolve([])),
        end: () => 'end',
      },
      close: async () => undefined,
    };
    const state = { lost: false };
    const fenced = fenceRagStore(conn, lockWith(state));
    await fenced.pg.unsafe('INSERT 1', [1]);
    state.lost = true;
    expect(() => fenced.pg.unsafe('INSERT 2', [2])).toThrow(RagSyncLockLostError);
    expect(sent).toEqual([['INSERT 1', [1]]]);
    expect(fenced.pg.end()).toBe('end');
    expect(fenced.close).toBe(conn.close);
    expect(fenced.mode).toBe('external');
  });

  it('returns the connection itself when there is no lock', () => {
    const conn = { pg: { unsafe: () => undefined } };
    expect(fenceRagStore(conn, null)).toBe(conn);
  });
});
