import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  TERMINAL_REPLY_CHANNEL_PREFIX,
  TERMINAL_REQUEST_CHANNEL,
  TERMINAL_SESSION_PREFIX,
  type TerminalOpenResult,
} from '@haive/shared';

/** Minimal ioredis fake. Only models the surface that runShellSession +
 *  resetStaleRefcounts touch. EventEmitter base lets us drive 'message'
 *  events from the test to simulate worker replies. */
class FakeRedis extends EventEmitter {
  private store = new Map<string, Map<string, string>>();
  hincrbyCalls: Array<{ key: string; field: string; delta: number; result: number }> = [];
  hsetCalls: Array<{ key: string; field: string; value: string }> = [];
  hsetnxCalls: Array<{ key: string; field: string; value: string; result: number }> = [];
  hgetCalls: Array<{ key: string; field: string }> = [];
  publishCalls: Array<{ channel: string; data: string }> = [];
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];
  quitCalled = false;
  connectCalled = false;
  /** Spawned via `duplicate()`. Tests use these to inject 'message' frames. */
  duplicates: FakeRedis[] = [];
  /** Synthetic mode toggle: when true, hincrby/hset reject with the
   *  ioredis "Connection is closed" error to emulate a quit() race. */
  closed = false;
  /** When true, subscribe() returns a Promise that never resolves until
   *  quit() rejects all pending ones with "Connection is closed". This
   *  reproduces the ioredis behaviour that crashed the API pre-fix:
   *  subscribe was pending, quit() killed the socket, the rejected
   *  subscribe became an unhandled rejection. */
  holdSubscribe = false;
  private pendingSubscribes: Array<{ reject: (err: Error) => void }> = [];

  duplicate(): this {
    const child = new FakeRedis() as this;
    this.duplicates.push(child);
    return child;
  }

  async connect(): Promise<void> {
    this.connectCalled = true;
  }

  async quit(): Promise<'OK'> {
    this.quitCalled = true;
    this.closed = true;
    for (const p of this.pendingSubscribes) {
      p.reject(new Error('Connection is closed.'));
    }
    this.pendingSubscribes = [];
    return 'OK';
  }

  async hincrby(key: string, field: string, delta: number): Promise<number> {
    if (this.closed) throw new Error('Connection is closed.');
    const h = this.store.get(key) ?? new Map<string, string>();
    const cur = Number.parseInt(h.get(field) ?? '0', 10);
    const next = cur + delta;
    h.set(field, String(next));
    this.store.set(key, h);
    this.hincrbyCalls.push({ key, field, delta, result: next });
    return next;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    if (this.closed) throw new Error('Connection is closed.');
    const h = this.store.get(key) ?? new Map<string, string>();
    const created = h.has(field) ? 0 : 1;
    h.set(field, value);
    this.store.set(key, h);
    this.hsetCalls.push({ key, field, value });
    return created;
  }

  async hsetnx(key: string, field: string, value: string): Promise<number> {
    if (this.closed) throw new Error('Connection is closed.');
    const h = this.store.get(key) ?? new Map<string, string>();
    if (h.has(field)) {
      this.hsetnxCalls.push({ key, field, value, result: 0 });
      return 0;
    }
    h.set(field, value);
    this.store.set(key, h);
    this.hsetnxCalls.push({ key, field, value, result: 1 });
    return 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.hgetCalls.push({ key, field });
    return this.store.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.store.get(key);
    if (!h) return {};
    return Object.fromEntries(h);
  }

  async scan(
    cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _n: string,
  ): Promise<[string, string[]]> {
    if (cursor !== '0') return ['0', []];
    const prefix = pattern.replace(/\*$/, '');
    const matched = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
    return ['0', matched];
  }

  async publish(channel: string, data: string): Promise<number> {
    this.publishCalls.push({ channel, data });
    return 0;
  }

  async subscribe(channel: string): Promise<number> {
    if (this.closed) throw new Error('Connection is closed.');
    this.subscribeCalls.push(channel);
    if (this.holdSubscribe) {
      return new Promise<number>((_resolve, reject) => {
        this.pendingSubscribes.push({ reject });
      });
    }
    return 1;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.unsubscribeCalls.push(channel);
    return 1;
  }

  /** Test helper: deliver a JSON reply on the subscribed reply channel as
   *  if the worker had published it. */
  emitReply(
    replyChannel: string,
    payload: TerminalOpenResult | { ok: false; error: string },
  ): void {
    this.emit('message', replyChannel, JSON.stringify(payload));
  }

  /** Test helper: deliver raw PTY bytes on the out-channel. */
  emitOutput(outChannel: string, raw: string): void {
    this.emit('message', outChannel, raw);
  }

  storeFor(key: string): Map<string, string> | undefined {
    return this.store.get(key);
  }

  seed(key: string, fields: Record<string, string>): void {
    const h = new Map(Object.entries(fields));
    this.store.set(key, h);
  }
}

/** Minimal ws fake. ws.WebSocket.OPEN===1, CLOSED===3 — match those. */
class FakeWs extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWs.OPEN;
  sent: string[] = [];
  pingCount = 0;

  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pingCount += 1;
  }
  close(_code?: number, _reason?: string): void {
    if (this.readyState === FakeWs.CLOSED) return;
    this.readyState = FakeWs.CLOSED;
    // Real ws emits 'close' asynchronously via socket teardown — mirror
    // that with a queueMicrotask so the close handler doesn't run before
    // the line that called .close() returns.
    queueMicrotask(() => this.emit('close', 1000, ''));
  }
}

let publisherFake: FakeRedis;

vi.mock('../src/redis.js', () => ({
  getRedis: () => publisherFake,
  initRedis: () => ({ redis: publisherFake, bullRedis: publisherFake }),
  getBullRedis: () => publisherFake,
  closeRedis: async () => undefined,
}));

const { runShellSession, resetStaleRefcounts } = await import('../src/routes/terminal-shell.js');

beforeEach(() => {
  publisherFake = new FakeRedis();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resetStaleRefcounts', () => {
  it('zeros refcount fields with non-zero values', async () => {
    publisherFake.seed(`${TERMINAL_SESSION_PREFIX}u1:t1:p1`, {
      refcount: '3',
      lastSeenAt: '1234',
      containerName: 'haive-shell-aaa',
    });
    publisherFake.seed(`${TERMINAL_SESSION_PREFIX}u2:t2:p2`, {
      refcount: '1',
      containerName: 'haive-shell-bbb',
    });

    await resetStaleRefcounts(publisherFake as unknown as Redis);

    expect(publisherFake.storeFor(`${TERMINAL_SESSION_PREFIX}u1:t1:p1`)?.get('refcount')).toBe('0');
    expect(publisherFake.storeFor(`${TERMINAL_SESSION_PREFIX}u2:t2:p2`)?.get('refcount')).toBe('0');
  });

  it('skips entries already at refcount 0', async () => {
    publisherFake.seed(`${TERMINAL_SESSION_PREFIX}u1:t1:p1`, {
      refcount: '0',
      containerName: 'haive-shell-zero',
    });

    await resetStaleRefcounts(publisherFake as unknown as Redis);

    expect(publisherFake.hsetCalls).toEqual([]);
  });

  it('handles an empty registry without error', async () => {
    await expect(resetStaleRefcounts(publisherFake as unknown as Redis)).resolves.toBeUndefined();
  });

  it('only touches keys under the terminal session prefix', async () => {
    publisherFake.seed(`${TERMINAL_SESSION_PREFIX}u1:t1:p1`, {
      refcount: '4',
      containerName: 'haive-shell-aaa',
    });
    publisherFake.seed('bull:queue:1', { refcount: '99' });

    await resetStaleRefcounts(publisherFake as unknown as Redis);

    expect(publisherFake.storeFor('bull:queue:1')?.get('refcount')).toBe('99');
    expect(publisherFake.storeFor(`${TERMINAL_SESSION_PREFIX}u1:t1:p1`)?.get('refcount')).toBe('0');
  });
});

describe('runShellSession refcount lifecycle', () => {
  function captureCorrelationId(): { correlationId: string; replyChannel: string } {
    const openPub = publisherFake.publishCalls.find((c) => c.channel === TERMINAL_REQUEST_CHANNEL);
    expect(openPub, 'expected an open request publish').toBeDefined();
    const parsed = JSON.parse(openPub!.data) as { correlationId: string };
    return {
      correlationId: parsed.correlationId,
      replyChannel: `${TERMINAL_REPLY_CHANNEL_PREFIX}${parsed.correlationId}`,
    };
  }

  function registryKey(userId: string, taskId: string, providerId: string): string {
    return `${TERMINAL_SESSION_PREFIX}${userId}:${taskId}:${providerId}`;
  }

  function refcountIncrements(): Array<{ delta: number; result: number }> {
    return publisherFake.hincrbyCalls
      .filter((c) => c.field === 'refcount')
      .map((c) => ({ delta: c.delta, result: c.result }));
  }

  /** Wait for the runShellSession async function to reach its first
   *  subscribe call (which means it has registered ws.on('close') and is
   *  in the openSession await). Polling the spawned subscriber's
   *  subscribeCalls is a deterministic signal — no fixed sleep. */
  async function waitForOpenInFlight(): Promise<FakeRedis> {
    for (let i = 0; i < 50; i += 1) {
      const sub = publisherFake.duplicates[0];
      if (sub && sub.subscribeCalls.length > 0) return sub;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('openSession did not reach subscribe within 50 ticks');
  }

  /** Drain enough microtasks/macrotasks for the ws 'close' handler chain
   *  (cleanup → hincrby/hset → log) to fully settle. */
  async function drainCloseHandler(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it('happy path: refcount goes 0 -> 1 on connect, 1 -> 0 on close', async () => {
    const ws = new FakeWs();
    const userId = 'u1';
    const taskId = 't1';
    const providerId = 'p1';

    const sessionPromise = runShellSession(ws as never, userId, taskId, providerId);
    const sub = await waitForOpenInFlight();
    const { replyChannel } = captureCorrelationId();

    sub.emitReply(replyChannel, {
      ok: true,
      sessionId: 'sess-1',
      containerName: 'haive-shell-1',
      shell: 'bash',
    });

    // Let the post-openSession code (hincrby + subscribe + sendJson) finish.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const key = registryKey(userId, taskId, providerId);
    expect(publisherFake.storeFor(key)?.get('refcount')).toBe('1');

    // The "connected" frame should have been sent to the WS.
    expect(ws.sent.some((f) => JSON.parse(f).type === 'connected')).toBe(true);

    // sessionPromise resolves once setup is complete — the cleanup path
    // runs from ws.on('close') AFTER that. Drain ticks until the close
    // handler's hincrby -1 has settled.
    await sessionPromise;
    ws.close(1000, 'unmount');
    await drainCloseHandler();

    expect(publisherFake.storeFor(key)?.get('refcount')).toBe('0');
    expect(refcountIncrements()).toEqual([
      { delta: 1, result: 1 },
      { delta: -1, result: 0 },
    ]);
  });

  it('StrictMode: ws.close during openSession produces no refcount mutation', async () => {
    const ws = new FakeWs();
    const userId = 'u1';
    const taskId = 't1';
    const providerId = 'p1';

    const sessionPromise = runShellSession(ws as never, userId, taskId, providerId);
    const sub = await waitForOpenInFlight();
    const { replyChannel } = captureCorrelationId();

    // Simulate React StrictMode: the first effect's cleanup fires close
    // while we're still waiting on the worker reply.
    ws.close(1000, 'strictmode-unmount');

    // Let the close microtask drain, then deliver the worker reply
    // (worker doesn't know the WS died — it replies as normal).
    await new Promise((r) => setImmediate(r));
    sub.emitReply(replyChannel, {
      ok: true,
      sessionId: 'sess-strict',
      containerName: 'haive-shell-strict',
      shell: 'bash',
    });

    await sessionPromise;

    // The bug we fixed: pre-fix this would show `[{ delta: 1, result: 1 }]`
    // — an orphan +1 with no matching -1. Post-fix: zero hincrby calls
    // because cleanupRan was true by the time the post-openSession code
    // ran.
    expect(refcountIncrements()).toEqual([]);
    expect(sub.quitCalled).toBe(true);
  });

  it('open failure (worker reports error) sends error frame and never touches refcount', async () => {
    const ws = new FakeWs();

    const sessionPromise = runShellSession(ws as never, 'u1', 't1', 'p1');
    const sub = await waitForOpenInFlight();
    const { replyChannel } = captureCorrelationId();

    sub.emitReply(replyChannel, { ok: false, error: 'no provider auth' });

    await sessionPromise;

    expect(refcountIncrements()).toEqual([]);
    const errorFrame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'error');
    expect(errorFrame).toEqual({ type: 'error', message: 'no provider auth' });
    expect(sub.quitCalled).toBe(true);
  });

  it('subscriber.quit during pending openSession does NOT crash the process', async () => {
    // Regression test for the ioredis "Connection is closed." crash. Pre-fix:
    // openSession's `void subscriber.subscribe(...).then(...)` had no .catch,
    // so when cleanup() called subscriber.quit() during the open window the
    // pending subscribe rejected as an unhandled rejection and Node v24
    // exited the process. Post-fix: subscribe's catch + the subscriber's
    // on('error') listener swallow it.
    //
    // We rig the duplicated subscriber to hold the subscribe() promise so
    // that quit() actually has a pending operation to reject — without
    // that, the test passes trivially (subscribe resolved before quit hit).
    const originalDuplicate = publisherFake.duplicate.bind(publisherFake);
    publisherFake.duplicate = function (this: FakeRedis): FakeRedis {
      const child = originalDuplicate();
      child.holdSubscribe = true;
      return child;
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      const ws = new FakeWs();
      const sessionPromise = runShellSession(ws as never, 'u1', 't1', 'p1');
      const sub = await waitForOpenInFlight();

      // Close ws — this triggers cleanup() → subscriber.quit() while the
      // openSession subscribe is still pending. Pre-fix, the subscribe
      // rejection here became unhandledRejection and crashed Node.
      ws.close(1000, 'race');
      await drainCloseHandler();

      // sessionPromise resolves once openSession's catch fires (the
      // subscribe rejection drives openSession to reject, runShellSession
      // catches it as { ok: false }, and the post-openSession path bails).
      await sessionPromise;
      // One more tick so any straggler microtask rejection surfaces.
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(sub.quitCalled).toBe(true);
      expect(refcountIncrements()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
