import net from 'node:net';
import { Hono } from 'hono';
import { ReplyError } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/context.js';
import { closeRedis, getPatientRedis, getRedis, initRedis } from '../src/redis.js';

type Fake = {
  port: number;
  commands: string[][];
  mute: boolean;
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
  const fake: Fake = {
    port: 0,
    commands: [],
    mute: false,
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
  const deadline = Date.now() + 5000;
  while (getRedis().status !== 'ready') {
    if (Date.now() > deadline) throw new Error('redis client never became ready');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

afterEach(async () => {
  if (fake) fake.mute = false;
  await closeRedis();
  await fake?.stop();
  fake = null;
});

describe('api shared Redis client is bounded', () => {
  it('a) closed port rejects typed within 500 ms', async () => {
    init(await closedPort());
    const t0 = Date.now();
    const e = await rejection(getRedis().get('k'));
    expect(isTyped503(e)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('b) silent server rejects typed after about 2 s', async () => {
    fake = await startFake();
    init(fake.port);
    await waitReady();
    fake.mute = true;
    const t0 = Date.now();
    const e = await rejection(getRedis().get('k'));
    const ms = Date.now() - t0;
    expect(isTyped503(e)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(1500);
    expect(ms).toBeLessThanOrEqual(3500);
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
    const e = await rejection(getRedis().set('k', 'v'));
    expect(isTyped503(e)).toBe(true);
    fake.mute = false;
    fake.dropAll();
    await new Promise((r) => setTimeout(r, 50));
    await waitReady();
    await new Promise((r) => setTimeout(r, 300));
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
    await new Promise((r) => setTimeout(r, 300));
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
