import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RagSyncLockAbortedError,
  RagSyncLockTimeoutError,
  acquireRagSyncLock,
  ragSyncLockKey,
  tryAcquireRagSyncLock,
} from '../src/rag/sync-lock.js';

const URL = process.env.HAIVE_RAG_LOCK_TEST_REDIS_URL;

describe.skipIf(!URL)('RAG sync lock on a real Redis', () => {
  const redis = new Redis(URL ?? 'redis://127.0.0.1:1', { lazyConnect: true });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  afterAll(async () => {
    await redis.quit();
  });

  it('holds one key per repository with an owner token and a bounded expiry', async () => {
    const repo = randomUUID();
    const held = await tryAcquireRagSyncLock(redis, repo);
    expect(held).not.toBeNull();
    expect(await redis.get(ragSyncLockKey(repo))).toMatch(/^[0-9a-f-]{36}$/);
    const ttl = await redis.pttl(ragSyncLockKey(repo));
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(120_000);
    expect(await tryAcquireRagSyncLock(redis, repo)).toBeNull();
    await held!.release();
    expect(await redis.exists(ragSyncLockKey(repo))).toBe(0);
    const again = await tryAcquireRagSyncLock(redis, repo);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it('makes a second acquirer wait until the first released', async () => {
    const repo = randomUUID();
    const first = await acquireRagSyncLock(redis, repo, { waitMs: 5_000, pollMs: 20 });
    const events: string[] = [];
    let waits = 0;
    const second = acquireRagSyncLock(redis, repo, {
      waitMs: 5_000,
      pollMs: 20,
      onWait: () => void (waits += 1),
    }).then((h) => {
      events.push('second-acquired');
      return h;
    });
    await sleep(200);
    expect(events).toEqual([]);
    expect(waits).toBeGreaterThan(0);
    events.push('first-released');
    await first.release();
    const handle = await second;
    expect(events).toEqual(['first-released', 'second-acquired']);
    await handle.release();
  });

  it('does not let different repositories block each other', async () => {
    const a = await tryAcquireRagSyncLock(redis, randomUUID());
    const b = await tryAcquireRagSyncLock(redis, randomUUID());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release();
    await b!.release();
  });

  it('times out at the bound and leaves the holder in place', async () => {
    const repo = randomUUID();
    const holder = await acquireRagSyncLock(redis, repo, { waitMs: 1_000 });
    const token = await redis.get(ragSyncLockKey(repo));
    await expect(acquireRagSyncLock(redis, repo, { waitMs: 150, pollMs: 20 })).rejects.toThrow(
      RagSyncLockTimeoutError,
    );
    expect(await redis.get(ragSyncLockKey(repo))).toBe(token);
    await holder.release();
  });

  it('rejects with the aborted error when the signal fires while waiting', async () => {
    const repo = randomUUID();
    const holder = await acquireRagSyncLock(redis, repo, { waitMs: 1_000 });
    const token = await redis.get(ragSyncLockKey(repo));
    const controller = new AbortController();
    const waiting = acquireRagSyncLock(redis, repo, {
      waitMs: 5_000,
      pollMs: 20,
      signal: controller.signal,
    });
    const settled = expect(waiting).rejects.toThrow(RagSyncLockAbortedError);
    await sleep(60);
    controller.abort();
    await settled;
    expect(await redis.get(ragSyncLockKey(repo))).toBe(token);
    await holder.release();
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      acquireRagSyncLock(redis, randomUUID(), { waitMs: 1_000, signal: controller.signal }),
    ).rejects.toThrow(RagSyncLockAbortedError);
  });

  it('frees a holder that never releases once its expiry passes', async () => {
    const repo = randomUUID();
    const dead = await tryAcquireRagSyncLock(redis, repo, { ttlMs: 250, heartbeatMs: 60_000 });
    expect(dead).not.toBeNull();
    expect(await tryAcquireRagSyncLock(redis, repo)).toBeNull();
    const next = await acquireRagSyncLock(redis, repo, { waitMs: 3_000, pollMs: 50 });
    await next.release();
    await dead!.release();
  });

  it('keeps a live holder past its expiry by heartbeating', async () => {
    const repo = randomUUID();
    const live = await tryAcquireRagSyncLock(redis, repo, { ttlMs: 300, heartbeatMs: 80 });
    await sleep(900);
    expect(live!.lost).toBe(false);
    expect(await tryAcquireRagSyncLock(redis, repo)).toBeNull();
    await live!.release();
  });

  it('flips lost when a heartbeat finds another token, and never deletes that key', async () => {
    const repo = randomUUID();
    const handle = await tryAcquireRagSyncLock(redis, repo, { ttlMs: 5_000, heartbeatMs: 40 });
    expect(handle!.lost).toBe(false);
    await redis.set(ragSyncLockKey(repo), 'someone-else', 'PX', 5_000);
    await sleep(200);
    expect(handle!.lost).toBe(true);
    await handle!.release();
    expect(await redis.get(ragSyncLockKey(repo))).toBe('someone-else');
    await redis.del(ragSyncLockKey(repo));
  });

  it('flips lost when the key expired and was never re-taken', async () => {
    const repo = randomUUID();
    const handle = await tryAcquireRagSyncLock(redis, repo, { ttlMs: 60, heartbeatMs: 200 });
    await sleep(400);
    expect(handle!.lost).toBe(true);
    await handle!.release();
  });
});
