import net from 'node:net';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONNECTION_ERROR_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
]);
const unhandled: unknown[] = [];

type Shape = 'hangup-accept' | 'hangup-startup' | 'hangup-query' | 'never-answer';

interface FakeServer {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

const msg = (type: string, body: Buffer): Buffer => {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0, 'latin1');
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
};
const cstr = (s: string): Buffer => Buffer.from(`${s}\0`, 'utf8');

const startupReply = (): Buffer => {
  const authOk = msg('R', Buffer.from([0, 0, 0, 0]));
  const param = (k: string, v: string) => msg('S', Buffer.concat([cstr(k), cstr(v)]));
  const key = Buffer.alloc(8);
  return Buffer.concat([
    authOk,
    param('server_version', '18.0'),
    param('client_encoding', 'UTF8'),
    param('standard_conforming_strings', 'on'),
    msg('K', key),
    msg('Z', Buffer.from('I')),
  ]);
};

async function fakeServer(shape: Shape): Promise<FakeServer> {
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (shape === 'hangup-accept') {
      socket.destroy();
      return;
    }
    if (shape === 'never-answer') return;
    let started = false;
    socket.on('data', () => {
      if (shape === 'hangup-startup') {
        socket.destroy();
        return;
      }
      if (!started) {
        started = true;
        socket.write(startupReply());
        return;
      }
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

interface Outcome {
  settled: 'rejected' | 'resolved' | 'pending';
  code: string | undefined;
  ms: number;
  connections: number;
  lateConnections: number;
}

async function runBegin(
  shape: Shape,
  opts: { fetchTypes: boolean; connectTimeout: number; windowMs: number },
): Promise<Outcome> {
  const server = await fakeServer(shape);
  const sql = postgres({
    host: '127.0.0.1',
    port: server.port,
    username: 'u',
    password: 'p',
    database: 'd',
    max: 1,
    connect_timeout: opts.connectTimeout,
    fetch_types: opts.fetchTypes,
    onnotice: () => {},
  });
  try {
    const started = Date.now();
    const timer: { id?: NodeJS.Timeout } = {};
    const verdict = await Promise.race([
      sql
        .begin(async (tx) => tx`select 1`)
        .then(
          () => ({ settled: 'resolved' as const, code: undefined }),
          (err: { code?: string }) => ({ settled: 'rejected' as const, code: err.code }),
        ),
      new Promise<{ settled: 'pending'; code: undefined }>((resolve) => {
        timer.id = setTimeout(
          () => resolve({ settled: 'pending', code: undefined }),
          opts.windowMs,
        );
      }),
    ]);
    clearTimeout(timer.id);
    const ms = Date.now() - started;
    const connections = server.connections();
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { ...verdict, ms, connections, lateConnections: server.connections() - connections };
  } finally {
    await sql.end({ timeout: 0 });
    await server.close();
  }
}

const expectRejectedWithoutStorm = (out: Outcome): void => {
  expect(out.settled, `settled (${out.connections} connections in ${out.ms} ms)`).toBe('rejected');
  expect(out.ms).toBeLessThan(1500);
  expect(out.connections, 'connections the server saw').toBeLessThanOrEqual(15);
  expect(out.lateConnections, 'connections in the 500 ms after the rejection').toBe(0);
};

describe('a store that hangs up while a connection starts', () => {
  // postgres.js starts its array-type query unawaited, so destroying a pool that is still starting
  // rejects it with nobody listening; that is not what this file measures, and vitest would fail the run on it.
  const saved: Array<(...args: unknown[]) => void> = [];
  beforeAll(() => {
    unhandled.length = 0;
    saved.push(...(process.listeners('unhandledRejection') as Array<(...args: unknown[]) => void>));
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', (reason) => void unhandled.push(reason));
  });
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.removeAllListeners('unhandledRejection');
    for (const listener of saved) process.on('unhandledRejection', listener);
    // Only the driver's own unawaited type query may reject unheard, and only with a connection error.
    const codes = unhandled.map((r) => (r as { code?: unknown } | null)?.code);
    expect(codes.filter((c) => !CONNECTION_ERROR_CODES.has(String(c)))).toEqual([]);
  });

  const cases: Array<{ shape: Shape; fetchTypes: boolean }> = [
    { shape: 'hangup-accept', fetchTypes: false },
    { shape: 'hangup-accept', fetchTypes: true },
    { shape: 'hangup-startup', fetchTypes: false },
    { shape: 'hangup-startup', fetchTypes: true },
    { shape: 'hangup-query', fetchTypes: false },
    { shape: 'hangup-query', fetchTypes: true },
  ];

  for (const { shape, fetchTypes } of cases) {
    it(`pg.begin rejects without a reconnect storm: ${shape}, fetch_types ${fetchTypes ? 'on' : 'off'}`, async () => {
      const out = await runBegin(shape, { fetchTypes, connectTimeout: 2, windowMs: 1500 });
      expectRejectedWithoutStorm(out);
    }, 15_000);
  }

  it('positive control: a store that never answers rejects CONNECT_TIMEOUT', async () => {
    const out = await runBegin('never-answer', {
      fetchTypes: false,
      connectTimeout: 1,
      windowMs: 1500,
    });
    expect(out.settled).toBe('rejected');
    expect(out.code).toBe('CONNECT_TIMEOUT');
    expect(out.ms).toBeLessThan(1500);
    expect(out.connections).toBeLessThanOrEqual(2);
  }, 15_000);
});
