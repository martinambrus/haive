import net from 'node:net';
import { once } from 'node:events';
import { Hono } from 'hono';
import { ReplyError } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/context.js';
import { closeRedis, getPatientRedis, getRedis, initRedis } from '../src/redis.js';

type Fake = {
  port: number;
  commands: string[][];
  mute: boolean;
  nextCommand: (name: string) => Promise<void>;
  dropAll: () => void;
  stop: () => Promise<void>;
};

function parseCommands(buf: Buffer): { cmds: string[][]; rest: Buffer } {
  const cmds: string[][] = [];
  let pos = 0;
  for (;;) {
    if (buf[pos] !== 0x2a) break;
    let p = pos;
    const eol = buf.indexOf('\r\n', p);
    if (eol < 0) break;
    const count = Number(buf.subarray(p + 1, eol).toString());
    p = eol + 2;
    const args: string[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      const e = buf.indexOf('\r\n', p);
      if (e < 0) {
        ok = false;
        break;
      }
      const len = Number(buf.subarray(p + 1, e).toString());
      if (buf.length < e + 2 + len + 2) {
        ok = false;
        break;
      }
      args.push(buf.subarray(e + 2, e + 2 + len).toString());
      p = e + 2 + len + 2;
    }
    if (!ok) break;
    cmds.push(args);
    pos = p;
  }
  return { cmds, rest: buf.subarray(pos) };
}

async function startFake(): Promise<Fake> {
  const sockets = new Set<net.Socket>();
  const waiters: Array<{ name: string; resolve: () => void }> = [];
  const fake: Fake = {
    port: 0,
    commands: [],
    mute: false,
    nextCommand: (name) => new Promise((resolve) => waiters.push({ name, resolve })),
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    stop: async () => {
      fake.dropAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let pending: Buffer = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { cmds, rest } = parseCommands(pending);
      pending = Buffer.from(rest);
      for (const args of cmds) {
        fake.commands.push(args);
        for (const waiter of waiters.filter((w) => w.name === args[0]!.toUpperCase())) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
        if (fake.mute) continue;
        const name = args[0]!.toUpperCase();
        if (name === 'INFO') {
          const body = 'redis_version:7.0.0\r\nloading:0\r\n';
          sock.write(`$${body.length}\r\n${body}\r\n`);
        } else if (name === 'GET') sock.write('$-1\r\n');
        else if (name === 'PING') sock.write('+PONG\r\n');
        else if (name === 'HSET' && args[1] === 'wrongkey')
          sock.write('-WRONGTYPE Operation against a key holding the wrong kind of value\r\n');
        else sock.write('+OK\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.port = (server.address() as net.AddressInfo).port;
  return fake;
}

async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const isTyped503 = (e: unknown): boolean =>
  e instanceof HttpError && e.status === 503 && e.code === 'redis_unavailable';

let fake: Fake | null = null;

function init(port: number) {
  const clients = initRedis(`redis://127.0.0.1:${port}`);
  const { patientRedis, bullRedis } = clients as Partial<typeof clients>;
  patientRedis?.on('error', () => undefined);
  bullRedis?.on('error', () => undefined);
  return clients;
}

async function waitReady(): Promise<void> {
  const redis = getRedis();
  if (redis.status !== 'ready') await once(redis, 'ready');
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));

async function commandTimeout(work: Promise<unknown>, command: string): Promise<unknown> {
  let settled = false;
  const result = rejection(work).then((err) => {
    settled = true;
    return err;
  });
  await fake!.nextCommand(command);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  return result;
}

afterEach(async () => {
  if (fake) fake.mute = false;
  const closing = closeRedis();
  await vi.advanceTimersByTimeAsync(2_000);
  await closing;
  await fake?.stop();
  fake = null;
  vi.useRealTimers();
});

describe('api shared Redis client is bounded', () => {
  it('a) closed port rejects typed without queueing', async () => {
    init(await closedPort());
    const e = await rejection(getRedis().get('k'));
    expect(isTyped503(e)).toBe(true);
    expect(
      (getRedis() as unknown as { offlineQueue: { length: number } }).offlineQueue.length,
    ).toBe(0);
    expect(getRedis().options.enableOfflineQueue).toBe(false);
  });

  it('b) silent server rejects typed at the command deadline', async () => {
    fake = await startFake();
    init(fake.port);
    await waitReady();
    fake.mute = true;
    const e = await commandTimeout(getRedis().get('k'), 'GET');
    expect(isTyped503(e)).toBe(true);
    expect(getRedis().options.commandTimeout).toBe(2_000);
  });

  it('c) a server error reply passes through as a ReplyError', async () => {
    fake = await startFake();
    init(fake.port);
    await waitReady();
    const e = await rejection(getRedis().hset('wrongkey', 'f', 'v'));
    expect(e).toBeInstanceOf(ReplyError);
    expect(isTyped503(e)).toBe(false);
  });

  it('d) a rejected write is not replayed after recovery', async () => {
    fake = await startFake();
    init(fake.port);
    await waitReady();
    fake.mute = true;
    const e = await commandTimeout(getRedis().set('k', 'v'), 'SET');
    expect(isTyped503(e)).toBe(true);
    fake.mute = false;
    const closed = once(getRedis(), 'close');
    fake.dropAll();
    await closed;
    const ready = waitReady();
    await vi.advanceTimersByTimeAsync(50);
    await ready;
    // A successful command fences the recovered connection after any replayed writes.
    expect(await getRedis().ping()).toBe('PONG');
    expect(getRedis().options.autoResendUnfulfilledCommands).toBe(false);
    expect(fake.commands.filter((c) => c[0]!.toUpperCase() === 'SET')).toHaveLength(1);
  });

  it('e) pipeline inner errors and multi rejection are typed', async () => {
    init(await closedPort());
    const res = await getRedis().pipeline().set('a', '1').get('a').exec();
    expect(res).toHaveLength(2);
    for (const [err] of res!) expect(isTyped503(err)).toBe(true);
    const e = await rejection(getRedis().multi().hset('h', 'f', 'v').expire('h', 10).exec());
    expect(isTyped503(e)).toBe(true);
  });

  it('f) the patient client waits; duplicates behave per client', async () => {
    init(await closedPort());
    let settled = false;
    getPatientRedis()
      .get('k')
      .then(
        () => (settled = true),
        () => (settled = true),
      )
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(300);
    expect(
      (getPatientRedis() as unknown as { offlineQueue: { length: number } }).offlineQueue.length,
    ).toBe(1);
    expect(settled).toBe(false);
    const dup = getPatientRedis().duplicate();
    dup.on('error', () => undefined);
    expect(dup.options.enableOfflineQueue).toBe(true);
    expect(dup.options.commandTimeout).toBeUndefined();
    dup.disconnect();
    expect(() => getRedis().duplicate()).toThrow();
  });

  it('g) errorHandler answers RedisUnavailableError as a bare 503', async () => {
    const { RedisUnavailableError } = await import('../src/lib/redis-unavailable.js');
    const { errorHandler } = await import('../src/middleware/error-handler.js');
    const app = new Hono();
    app.onError(errorHandler as never);
    app.get('/x', () => {
      throw new RedisUnavailableError(new Error('secret-host:6379'));
    });
    const res = await app.request('/x');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Service temporarily unavailable',
      code: 'redis_unavailable',
    });
  });
});
