import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { ReplyError } from 'ioredis';
import {
  CONFIG_KEYS,
  ConfigService,
  ConfigUnavailableError,
  rethrowIfConfigUnavailable,
} from '../src/config/index.js';

type Mode = 'healthy' | 'silent';

/** Just enough RESP2 for ioredis: arrays of bulk strings in, simple replies out. */
class FakeRedis {
  mode: Mode = 'healthy';
  port = 0;
  /** Commands applied while healthy, in order. */
  applied: string[][] = [];
  /** Every command the server read, healthy or not. */
  received: string[][] = [];
  store = new Map<string, string>();
  getError: string | null = null;
  /** Upper-case command names on which the server destroys the socket. */
  dropOn = new Set<string>();
  /** Upper-case command names the server swallows without replying. */
  silentOn = new Set<string>();
  connections = 0;
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  async start(): Promise<void> {
    await this.listen(this.port);
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        this.server = server;
        resolve();
      });
    });
  }

  /** Close the listener and every connection: connects are refused until restart(). */
  async refuse(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.dropConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Let the client notice the dead socket: a command written to one it has not yet seen
    // closing waits for the command timeout instead of failing at once.
    await new Promise((r) => setTimeout(r, 100));
  }

  restart(): Promise<void> {
    this.mode = 'healthy';
    return this.listen(this.port);
  }

  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  countApplied(name: string, key?: string): number {
    return this.applied.filter((c) => c[0]?.toUpperCase() === name && (!key || c[1] === key))
      .length;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    this.connections++;
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = parseCommand(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.used);
        this.handle(socket, parsed.args);
      }
    });
  }

  private handle(socket: Socket, args: string[]): void {
    this.received.push(args);
    if (this.mode === 'silent') return;
    const name = args[0]!.toUpperCase();
    if (this.silentOn.has(name)) return;
    if (this.dropOn.has(name)) return void socket.destroy();
    this.applied.push(args);
    switch (name) {
      case 'INFO':
        return void socket.write(bulk('# Persistence\r\nloading:0\r\n'));
      case 'GET': {
        if (this.getError) return void socket.write(`-${this.getError}\r\n`);
        const v = this.store.get(args[1]!);
        return void socket.write(v === undefined ? '$-1\r\n' : bulk(v));
      }
      case 'SET': {
        const nx = args.slice(3).some((a) => a.toUpperCase() === 'NX');
        if (nx && this.store.has(args[1]!)) return void socket.write('$-1\r\n');
        this.store.set(args[1]!, args[2]!);
        return void socket.write('+OK\r\n');
      }
      case 'SETNX': {
        const had = this.store.has(args[1]!);
        if (!had) this.store.set(args[1]!, args[2]!);
        return void socket.write(had ? ':0\r\n' : ':1\r\n');
      }
      case 'EXISTS':
        return void socket.write(`:${this.store.has(args[1]!) ? 1 : 0}\r\n`);
      case 'PUBLISH':
        return void socket.write(':0\r\n');
      case 'QUIT':
        socket.write('+OK\r\n');
        return void socket.end();
      default:
        return void socket.write('+OK\r\n');
    }
  }
}

function bulk(s: string): string {
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}

function parseCommand(buf: Buffer): { args: string[]; used: number } | null {
  if (buf.length === 0 || buf[0] !== 0x2a) return null;
  let pos = buf.indexOf('\r\n');
  if (pos < 0) return null;
  const count = Number(buf.subarray(1, pos).toString());
  pos += 2;
  const args: string[] = [];
  for (let i = 0; i < count; i++) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const len = Number(buf.subarray(pos + 1, eol).toString());
    const start = eol + 2;
    if (buf.length < start + len + 2) return null;
    args.push(buf.subarray(start, start + len).toString());
    pos = start + len + 2;
  }
  return { args, used: pos };
}

const ENC_KEY = 'ab'.repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timed<T>(p: Promise<T>): Promise<{ err: unknown; ms: number }> {
  const t0 = Date.now();
  try {
    await p;
  } catch (err) {
    return { err, ms: Date.now() - t0 };
  }
  throw new Error('expected rejection');
}

describe('ConfigService while Redis is unavailable', () => {
  let savedKey: string | undefined;
  let fake: FakeRedis;
  let svc: ConfigService;

  beforeAll(() => {
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = ENC_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  });

  /** A rejected initialize leaves its reconnecting client open; close it. */
  function disconnectLeaked(): void {
    (svc as unknown as { redis: { disconnect(): void } | null }).redis?.disconnect();
  }

  async function boot(): Promise<void> {
    fake = new FakeRedis();
    await fake.start();
    svc = new ConfigService();
    await svc.initialize(fake.url());
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      svc?.getRedis().disconnect();
    } catch {
      // already closed by the test
    }
    await fake?.refuse();
  });

  it('works while healthy and serves a second get from cache', async () => {
    await boot();
    await svc.set('k:a', '1');
    expect(await svc.getFresh('k:a')).toBe('1');
    const before = fake.countApplied('GET', 'k:b');
    fake.store.set('k:b', 'x');
    expect(await svc.get('k:b')).toBe('x');
    expect(await svc.get('k:b')).toBe('x');
    expect(fake.countApplied('GET', 'k:b') - before).toBe(1);
    expect(await svc.setIfAbsent('k:c', 'y')).toBe(true);
    expect(await svc.setIfAbsent('k:c', 'z')).toBe(false);
    await svc.publish('chan', 'msg');
    expect(fake.countApplied('PUBLISH')).toBe(1);
  });

  it('rejects every call quickly with ConfigUnavailableError once refused', async () => {
    await boot();
    await fake.refuse();
    const calls: Record<string, () => Promise<unknown>> = {
      get: () => svc.get('fresh:key'),
      getFresh: () => svc.getFresh('fresh:key'),
      set: () => svc.set('fresh:key', 'v'),
      setIfAbsent: () => svc.setIfAbsent('fresh:key', 'v'),
      publish: () => svc.publish('chan', 'm'),
      getNumber: () => svc.getNumber('fresh:num', 3),
      getBoolean: () => svc.getBoolean('fresh:bool', true),
    };
    for (const [name, call] of Object.entries(calls)) {
      const { err, ms } = await timed(call());
      expect(err, name).toBeInstanceOf(ConfigUnavailableError);
      const e = err as ConfigUnavailableError;
      expect(ms, name).toBeLessThan(800);
      expect(e.cause, name).toBeDefined();
      expect('code' in e, name).toBe(false);
      expect(e.message, name).toMatch(/^Configuration store unavailable \(\w+\)$/);
      expect(e.message).not.toContain(String(fake.port));
      expect(e.message).not.toContain('127.0.0.1');
      expect(e.message).not.toContain('fresh:');
      expect(() => rethrowIfConfigUnavailable(e)).toThrow(e);
    }
    expect(() => rethrowIfConfigUnavailable(new Error('other'))).not.toThrow();
  });

  it('rejects after the command timeout when the server is silent', async () => {
    await boot();
    fake.mode = 'silent';
    const { err, ms } = await timed(svc.get('silent:key'));
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect(ms).toBeGreaterThan(1800);
    expect(ms).toBeLessThan(3500);
  });

  it('recovers on the same instance after the server returns on the same port', async () => {
    await boot();
    await fake.refuse();
    await timed(svc.getFresh('rec:key'));
    await fake.restart();
    const t0 = Date.now();
    for (;;) {
      try {
        await svc.getFresh('rec:key');
        break;
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigUnavailableError);
        if (Date.now() - t0 > 2000) throw err;
        await sleep(50);
      }
    }
    await svc.set('rec:key', 'back');
    expect(fake.store.get('rec:key')).toBe('back');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('never applies a write that was rejected while refused', async () => {
    await boot();
    await fake.refuse();
    const { err } = await timed(svc.set('late:refused', 'v'));
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    await fake.restart();
    await sleep(1500);
    expect(fake.countApplied('SET', 'late:refused')).toBe(0);
    expect(fake.store.has('late:refused')).toBe(false);
  });

  it('never applies a write that timed out on a silent connection', async () => {
    await boot();
    fake.mode = 'silent';
    const { err } = await timed(svc.set('late:silent', 'v'));
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect(fake.received.some((c) => c[0] === 'set' && c[1] === 'late:silent')).toBe(true);
    fake.dropConnections();
    fake.mode = 'healthy';
    await sleep(1500);
    expect(fake.countApplied('SET', 'late:silent')).toBe(0);
    expect(fake.store.has('late:silent')).toBe(false);
  });

  it.each(['ERR boom', 'WRONGTYPE Operation against a key holding the wrong kind of value'])(
    'keeps a server error reply as a ReplyError (%s)',
    async (reply) => {
      await boot();
      fake.getError = reply;
      const { err } = await timed(svc.getFresh('reply:key'));
      expect(err).toBeInstanceOf(ReplyError);
      expect(err).not.toBeInstanceOf(ConfigUnavailableError);
    },
  );

  it('drops the cached entry when a write is rejected', async () => {
    await boot();
    fake.store.set('cache:key', 'old');
    expect(await svc.get('cache:key')).toBe('old');
    await fake.refuse();
    await timed(svc.set('cache:key', 'new'));
    await fake.restart();
    await sleep(700);
    const before = fake.countApplied('GET', 'cache:key');
    expect(await svc.get('cache:key')).toBe('old');
    expect(fake.countApplied('GET', 'cache:key') - before).toBe(1);
  });

  it.each(['refused', 'silent'] as const)(
    'getEncryptionKey rejects and writes nothing while %s',
    async (how) => {
      await boot();
      const setsBefore = fake.countApplied('SET', CONFIG_KEYS.ENCRYPTION_KEY);
      fake.store.delete(CONFIG_KEYS.ENCRYPTION_KEY);
      svc.clearCache();
      if (how === 'refused') await fake.refuse();
      else fake.mode = 'silent';
      const { err } = await timed(svc.getEncryptionKey());
      expect(err).toBeInstanceOf(ConfigUnavailableError);
      if (how === 'refused') await fake.restart();
      else {
        fake.dropConnections();
        fake.mode = 'healthy';
      }
      await sleep(1000);
      expect(fake.countApplied('SET', CONFIG_KEYS.ENCRYPTION_KEY)).toBe(setsBefore);
      expect(fake.store.has(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(false);
    },
  );

  it('fails initialize when the connection drops mid-seed', async () => {
    fake = new FakeRedis();
    fake.dropOn.add('SETNX');
    await fake.start();
    svc = new ConfigService();
    const { err } = await timed(svc.initialize(fake.url()));
    disconnectLeaked();
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect((err as ConfigUnavailableError).operation).toBe('seedDefaults');
    expect((err as ConfigUnavailableError).cause).toBeDefined();
  });

  const STALE_ATTACHMENT_CAP = String(25 * 1024 * 1024);

  it.each([
    { cmd: 'SETNX', op: 'seedDefaults', seed: {} },
    { cmd: 'GET', op: 'reconcileRaisedDefaults', seed: {} },
    {
      cmd: 'SET',
      op: 'reconcileRaisedDefaults',
      seed: { [CONFIG_KEYS.TASK_ATTACHMENT_MAX_BYTES]: STALE_ATTACHMENT_CAP },
    },
    { cmd: 'EXISTS', op: 'ensureEncryptionKey', seed: {} },
    { cmd: 'SET', op: 'ensureEncryptionKey', seed: {} },
  ])(
    'fails initialize typed as $op when the connection drops on $cmd',
    async ({ cmd, op, seed }) => {
      fake = new FakeRedis();
      fake.dropOn.add(cmd);
      for (const [k, v] of Object.entries(seed)) fake.store.set(k, v);
      await fake.start();
      svc = new ConfigService();
      const { err, ms } = await timed(svc.initialize(fake.url()));
      disconnectLeaked();
      expect(err).toBeInstanceOf(ConfigUnavailableError);
      expect((err as ConfigUnavailableError).operation).toBe(op);
      expect(ms).toBeLessThan(3500);
    },
  );

  it('fails initialize typed as seedDefaults after the command timeout when SETNX is silent', async () => {
    fake = new FakeRedis();
    fake.silentOn.add('SETNX');
    await fake.start();
    svc = new ConfigService();
    const { err, ms } = await timed(svc.initialize(fake.url()));
    disconnectLeaked();
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect((err as ConfigUnavailableError).operation).toBe('seedDefaults');
    expect(ms).toBeGreaterThan(1800);
    expect(ms).toBeLessThan(3500);
  });

  it('keeps a server error reply on a boot-time call as a ReplyError', async () => {
    fake = new FakeRedis();
    fake.getError = 'ERR boom';
    await fake.start();
    svc = new ConfigService();
    const { err } = await timed(svc.initialize(fake.url()));
    disconnectLeaked();
    expect(err).toBeInstanceOf(ReplyError);
    expect(err).not.toBeInstanceOf(ConfigUnavailableError);
  });

  it('keeps the production key mismatch a plain Error', async () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      fake = new FakeRedis();
      fake.store.set(CONFIG_KEYS.ENCRYPTION_KEY, 'cd'.repeat(32));
      await fake.start();
      svc = new ConfigService();
      const { err } = await timed(svc.initialize(fake.url()));
      disconnectLeaked();
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ConfigUnavailableError);
      expect(err).not.toBeInstanceOf(ReplyError);
      // The abort exists to protect the stored key: it must not have been overwritten.
      expect(fake.countApplied('SET', CONFIG_KEYS.ENCRYPTION_KEY)).toBe(0);
      expect(fake.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe('cd'.repeat(32));
    } finally {
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
    }
  });

  it.each(['refused', 'silent'] as const)(
    'close() resolves and ends the client while %s',
    async (how) => {
      await boot();
      const redis = svc.getRedis();
      const disconnect = vi.spyOn(redis, 'disconnect');
      if (how === 'refused') await fake.refuse();
      else fake.mode = 'silent';
      const t0 = Date.now();
      await svc.close();
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(disconnect).toHaveBeenCalled();
      // disconnect() leaves `status` stale while the socket is already down, so assert the
      // behaviour that matters: the client never reconnects.
      const seen = fake.connections;
      if (how === 'refused') await fake.restart();
      else fake.mode = 'healthy';
      await sleep(700);
      expect(fake.connections).toBe(seen);
      expect(() => svc.getRedis()).toThrow(/not initialized/);
    },
  );
});
