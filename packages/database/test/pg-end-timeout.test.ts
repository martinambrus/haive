import { randomBytes } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';

it('end timeout rejects in-flight, queued, begin and reserve work at its deadline', async () => {
  const sockets = new Set<net.Socket>();
  const receivedQuery = Promise.withResolvers<void>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let started = false;
    socket.on('data', () => {
      if (started) {
        receivedQuery.resolve();
        return; // Keep the actual query in flight forever.
      }
      started = true;
      // PostgreSQL AuthenticationOk, then ReadyForQuery (idle).
      socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const sql = postgres({
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    username: 'u',
    password: randomBytes(12).toString('hex'),
    database: 'd',
    fetch_types: false,
    max: 1,
    max_pipeline: 1,
  });
  const results = new Map<string, unknown>();
  const observe = (label: string, work: PromiseLike<unknown>): Promise<void> =>
    Promise.resolve(work).then(
      () => void results.set(label, undefined),
      (error: unknown) => void results.set(label, error),
    );
  try {
    const inflight = observe('in-flight', sql`select 1`);
    await receivedQuery.promise;
    const begin = vi.fn(async (tx: postgres.TransactionSql) => tx`select 2`);
    const pending = [
      inflight,
      observe('queued', sql`select 3`),
      observe('begin', sql.begin(begin)),
      observe('reserve', sql.reserve()),
    ];
    // Ensure these are queued before end(), rather than refused as new work.
    while (sql.stats.waiting !== 3) await setImmediate();
    const closing = sql.end({ timeout: 0.05 });
    let ended = false;
    void closing.then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(49);
    expect(results.size).toBe(0);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Queue destruction happens at the deadline; the in-flight query then
    // rejects when the real socket reports its close, without more clock time.
    for (const label of ['queued', 'begin', 'reserve']) {
      expect(results.get(label), label).toHaveProperty('code', 'CONNECTION_DESTROYED');
    }
    await Promise.all(pending);
    await closing;
    expect(results.size).toBe(4);
    expect(results.get('in-flight')).toHaveProperty('code', 'CONNECTION_DESTROYED');
    expect(begin).not.toHaveBeenCalled();
  } finally {
    // Closing the peer also releases the fixture if a driver regression fails an assertion.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const closing = sql.end({ timeout: 0 });
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    vi.useRealTimers();
  }
});
