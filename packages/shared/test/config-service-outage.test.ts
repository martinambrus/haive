import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { ReplyError } from 'ioredis';
import {
  CONFIG_KEYS,
  ConfigService,
  ConfigUnavailableError,
  rethrowIfConfigUnavailable,
} from '../src/config/index.js';

type Mode = 'healthy' | 'silent' | 'loading';

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
  /** When set, INFO replies with this error text. */
  infoError: string | null = null;
  /** Upper-case command names on which the server destroys the socket. */
  dropOn = new Set<string>();
  /** Upper-case command names the server swallows without replying. */
  silentOn = new Set<string>();
  connections = 0;
  beforeEncryptionSet: (() => void) | null = null;
  private commandWaiters: Array<{ name: string; resolve: () => void }> = [];

  nextCommand(name: string): Promise<void> {
    return new Promise((resolve) => this.commandWaiters.push({ name, resolve }));
  }

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
    for (const waiter of this.commandWaiters.filter(
      (w) => w.name === '*' || w.name === args[0]!.toUpperCase(),
    )) {
      this.commandWaiters.splice(this.commandWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    if (this.mode === 'silent') return;
    const name = args[0]!.toUpperCase();
    if (this.mode === 'loading') {
      if (name === 'INFO') {
        return void socket.write(bulk('# Persistence\r\nloading:1\r\nloading_eta_seconds:2\r\n'));
      }
      return void socket.write('-LOADING Redis is loading the dataset in memory\r\n');
    }
    if (this.silentOn.has(name)) return;
    if (this.dropOn.has(name)) return void socket.destroy();
    this.applied.push(args);
    switch (name) {
      case 'INFO':
        if (this.infoError) return void socket.write(`-${this.infoError}\r\n`);
        return void socket.write(bulk('# Persistence\r\nloading:0\r\n'));
      case 'GET': {
        if (this.getError) return void socket.write(`-${this.getError}\r\n`);
        const v = this.store.get(args[1]!);
        return void socket.write(v === undefined ? '$-1\r\n' : bulk(v));
      }
      case 'SET': {
        if (args[1] === CONFIG_KEYS.ENCRYPTION_KEY) this.beforeEncryptionSet?.();
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
      case 'DEL':
        return void socket.write(`:${this.store.delete(args[1]!) ? 1 : 0}\r\n`);
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
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected rejection');
}

describe('ConfigService while Redis is unavailable', () => {
  let savedKey: string | undefined;
  let fake: FakeRedis;
  let svc: ConfigService;

  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));

  beforeAll(() => {
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = ENC_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  });

  async function boot(): Promise<void> {
    fake = new FakeRedis();
    await fake.start();
    svc = new ConfigService();
    await svc.initialize(fake.url());
  }

  afterEach(async () => {
    try {
      svc?.getRedis().disconnect();
    } catch {
      // already closed by the test
    }
    await fake?.refuse();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function refuse(): Promise<void> {
    const closed = once(svc.getRedis(), 'close');
    await fake.refuse();
    await closed;
  }

  async function recover(drop = false): Promise<void> {
    const redis = svc.getRedis();
    const ready = once(redis, 'ready');
    if (drop) {
      const closed = once(redis, 'close');
      fake.dropConnections();
      await closed;
    }
    // The first reconnect is armed for 50 ms. Readiness, not a sleep, fences later assertions.
    await vi.advanceTimersByTimeAsync(50);
    await ready;
    // Fence commands sent by reconnect callbacks before checking for replayed writes.
    expect(await redis.ping()).toBe('OK');
  }

  async function timed(p: Promise<unknown>): Promise<{ err: unknown }> {
    const result = rejection(p);
    const command = fake.dropOn.values().next().value ?? fake.silentOn.values().next().value;
    if (fake.mode === 'silent' || fake.mode === 'loading' || command) {
      await fake.nextCommand(command ?? 'INFO');
      await vi.advanceTimersByTimeAsync(2_000);
    }
    return { err: await result };
  }

  async function commandTimeout(p: Promise<unknown>, command: string): Promise<{ err: unknown }> {
    const received = fake.nextCommand(command);
    let settled = false;
    const result = rejection(p).then((err) => {
      settled = true;
      return { err };
    });
    await received;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    return result;
  }

  it('concurrent initializers use the key that wins the write race', async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    fake = new FakeRedis();
    await fake.start();
    // Another process installs and starts using its key after our missing-key read.
    fake.beforeEncryptionSet = () => {
      fake.beforeEncryptionSet = null;
      fake.store.set(CONFIG_KEYS.ENCRYPTION_KEY, ENC_KEY);
    };
    svc = new ConfigService();
    const peer = new ConfigService();
    try {
      await Promise.all([svc.initialize(fake.url()), peer.initialize(fake.url())]);
      expect(await svc.getEncryptionKey()).toBe(ENC_KEY);
      expect(await peer.getEncryptionKey()).toBe(ENC_KEY);
      expect(fake.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe(ENC_KEY);
    } finally {
      await peer.close();
      process.env.CONFIG_ENCRYPTION_KEY = ENC_KEY;
    }
  });

  it('checks a losing environment key against the stored winner in production', async () => {
    fake = new FakeRedis();
    await fake.start();
    fake.beforeEncryptionSet = () => fake.store.set(CONFIG_KEYS.ENCRYPTION_KEY, 'cd'.repeat(32));
    svc = new ConfigService();
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(svc.initialize(fake.url())).rejects.toThrow('does not match');
      expect(fake.store.get(CONFIG_KEYS.ENCRYPTION_KEY)).toBe('cd'.repeat(32));
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });

  it('a losing fallback environment key keeps rejecting in production', async () => {
    await boot();
    fake.store.delete(CONFIG_KEYS.ENCRYPTION_KEY);
    svc.clearCache();
    fake.beforeEncryptionSet = () => fake.store.set(CONFIG_KEYS.ENCRYPTION_KEY, 'cd'.repeat(32));
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(svc.getEncryptionKey()).rejects.toThrow('does not match');
      await expect(svc.getEncryptionKey()).rejects.toThrow('does not match');
      // After the cached null expires the ordinary read sees the winner and must still refuse it.
      svc.clearCache();
      await expect(svc.getEncryptionKey()).rejects.toThrow('does not match');
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });

  it('fallback key recovery returns and caches the stored winner', async () => {
    await boot();
    fake.store.delete(CONFIG_KEYS.ENCRYPTION_KEY);
    svc.clearCache();
    fake.beforeEncryptionSet = () => fake.store.set(CONFIG_KEYS.ENCRYPTION_KEY, 'cd'.repeat(32));
    expect(await svc.getEncryptionKey()).toBe('cd'.repeat(32));
    expect(await svc.getEncryptionKey()).toBe('cd'.repeat(32));
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

  it('rejects every call without queueing with ConfigUnavailableError once refused', async () => {
    await boot();
    await refuse();
    expect(svc.getRedis().options).toMatchObject({
      commandTimeout: 2_000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    });
    expect([1, 2, 20].map((n) => svc.getRedis().options.retryStrategy!(n))).toEqual([50, 100, 500]);
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
      const { err } = await timed(call());
      expect(err, name).toBeInstanceOf(ConfigUnavailableError);
      const e = err as ConfigUnavailableError;
      expect(
        (svc.getRedis() as unknown as { offlineQueue: { length: number } }).offlineQueue.length,
        name,
      ).toBe(0);
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
    const { err } = await commandTimeout(svc.get('silent:key'), 'GET');
    expect(err).toBeInstanceOf(ConfigUnavailableError);
  });

  it('recovers on the same instance after the server returns on the same port', async () => {
    await boot();
    await refuse();
    await timed(svc.getFresh('rec:key'));
    await fake.restart();
    await recover();
    expect(await svc.getFresh('rec:key')).toBeNull();
    await svc.set('rec:key', 'back');
    expect(fake.store.get('rec:key')).toBe('back');
  });

  it('never applies a write that was rejected while refused', async () => {
    await boot();
    await refuse();
    const { err } = await timed(svc.set('late:refused', 'v'));
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    await fake.restart();
    await recover();
    expect(fake.countApplied('SET', 'late:refused')).toBe(0);
    expect(fake.store.has('late:refused')).toBe(false);
  });

  it('never applies a write that timed out on a silent connection', async () => {
    await boot();
    fake.mode = 'silent';
    const { err } = await commandTimeout(svc.set('late:silent', 'v'), 'SET');
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect(fake.received.some((c) => c[0] === 'set' && c[1] === 'late:silent')).toBe(true);
    fake.mode = 'healthy';
    await recover(true);
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
    await refuse();
    await timed(svc.set('cache:key', 'new'));
    await fake.restart();
    await recover();
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
      if (how === 'refused') await refuse();
      else fake.mode = 'silent';
      const { err } = await (how === 'silent'
        ? commandTimeout(svc.getEncryptionKey(), 'GET')
        : timed(svc.getEncryptionKey()));
      expect(err).toBeInstanceOf(ConfigUnavailableError);
      if (how === 'refused') await fake.restart();
      else fake.mode = 'healthy';
      await recover(how === 'silent');
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
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect((err as ConfigUnavailableError).operation).toBe('seedDefaults');
    expect((err as ConfigUnavailableError).cause).toBeDefined();
  });

  const STALE_ATTACHMENT_CAP = String(25 * 1024 * 1024);

  it.each([
    { cmd: 'SETNX', op: 'seedDefaults', seed: {} },
    { cmd: 'GET', op: 'reconcileRaisedDefaults', seed: {} },
    { cmd: 'DEL', op: 'removeRetiredKeys', seed: {} },
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
      const { err } = await timed(svc.initialize(fake.url()));
      expect(err).toBeInstanceOf(ConfigUnavailableError);
      expect((err as ConfigUnavailableError).operation).toBe(op);
    },
  );

  it('fails initialize typed as seedDefaults after the command timeout when SETNX is silent', async () => {
    fake = new FakeRedis();
    fake.silentOn.add('SETNX');
    await fake.start();
    svc = new ConfigService();
    const { err } = await commandTimeout(svc.initialize(fake.url()), 'SETNX');
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect((err as ConfigUnavailableError).operation).toBe('seedDefaults');
  });

  it('keeps a server error reply on a boot-time call as a ReplyError', async () => {
    fake = new FakeRedis();
    fake.getError = 'ERR boom';
    await fake.start();
    svc = new ConfigService();
    const { err } = await timed(svc.initialize(fake.url()));
    expect(err).toBeInstanceOf(ReplyError);
    expect(err).not.toBeInstanceOf(ConfigUnavailableError);
  });

  async function withReadyTimeout(ms: number, fn: () => Promise<void>): Promise<void> {
    const cls = ConfigService as unknown as { READY_TIMEOUT_MS: number };
    const saved = cls.READY_TIMEOUT_MS;
    cls.READY_TIMEOUT_MS = ms;
    try {
      await fn();
    } finally {
      cls.READY_TIMEOUT_MS = saved;
    }
  }

  it('rejects initialize typed after the deadline while Redis is LOADING', async () => {
    await withReadyTimeout(400, async () => {
      fake = new FakeRedis();
      fake.mode = 'loading';
      await fake.start();
      svc = new ConfigService();
      const received = fake.nextCommand('INFO');
      let settled = false;
      const result = rejection(svc.initialize(fake.url())).then((err) => {
        settled = true;
        return { err };
      });
      await received;
      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { err } = await result;
      expect(err).toBeInstanceOf(ConfigUnavailableError);
      expect((err as ConfigUnavailableError).operation).toBe('initialize');
      expect((err as ConfigUnavailableError).cause).toBeDefined();
    });
  });

  it('does not reconnect after the LOADING deadline rejection', async () => {
    await withReadyTimeout(400, async () => {
      fake = new FakeRedis();
      fake.mode = 'loading';
      await fake.start();
      svc = new ConfigService();
      const received = fake.nextCommand('INFO');
      const result = rejection(svc.initialize(fake.url()));
      await received;
      await vi.advanceTimersByTimeAsync(400);
      await result;
      const seen = fake.connections;
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fake.connections).toBe(seen);
    });
  });

  it('rejects initialize typed against a refused store and leaks no client', async () => {
    fake = new FakeRedis();
    await fake.start();
    await fake.refuse();
    svc = new ConfigService();
    const { err } = await timed(svc.initialize(fake.url()));
    expect(err).toBeInstanceOf(ConfigUnavailableError);
    expect((err as ConfigUnavailableError).operation).toBe('initialize');

    await fake.restart();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.connections).toBe(0);
  });

  it('lets the same instance initialize again after a failed initialize', async () => {
    fake = new FakeRedis();
    await fake.start();
    await fake.refuse();
    svc = new ConfigService();
    await timed(svc.initialize(fake.url()));
    await fake.restart();
    await svc.initialize(fake.url());
    expect(svc.getRedis()).toBeDefined();
    expect(await svc.getFresh('again:key')).toBeNull();
  });

  it('rejects initialize typed after the deadline when the server is silent', async () => {
    await withReadyTimeout(400, async () => {
      fake = new FakeRedis();
      fake.mode = 'silent';
      await fake.start();
      svc = new ConfigService();
      const received = fake.nextCommand('*');
      let settled = false;
      const result = rejection(svc.initialize(fake.url())).then((err) => {
        settled = true;
        return { err };
      });
      await received;
      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { err } = await result;
      expect(err).toBeInstanceOf(ConfigUnavailableError);
      expect((err as ConfigUnavailableError).operation).toBe('initialize');
    });
  });

  it('keeps a server error at the ready check a ReplyError', async () => {
    fake = new FakeRedis();
    fake.infoError = 'ERR boom';
    await fake.start();
    svc = new ConfigService();
    const { err } = await timed(svc.initialize(fake.url()));
    expect(err).toBeInstanceOf(ReplyError);
    expect(err).not.toBeInstanceOf(ConfigUnavailableError);
  });

  it('closes its client when initialize fails mid-seed', async () => {
    fake = new FakeRedis();
    fake.dropOn.add('SETNX');
    await fake.start();
    svc = new ConfigService();
    await timed(svc.initialize(fake.url()));
    // A client left open would reconnect after the server drops it again.
    const seen = fake.connections;
    fake.dropConnections();
    await vi.advanceTimersByTimeAsync(800);
    expect(fake.connections).toBe(seen);
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
      if (how === 'refused') await refuse();
      else fake.mode = 'silent';
      const quit = how === 'silent' ? fake.nextCommand('QUIT') : null;
      let settled = false;
      const closing = svc.close().then(() => {
        settled = true;
      });
      if (quit) {
        await quit;
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await closing;
      expect(disconnect).toHaveBeenCalled();
      // disconnect() leaves `status` stale while the socket is already down, so assert the
      // behaviour that matters: the client never reconnects.
      const seen = fake.connections;
      if (how === 'refused') await fake.restart();
      else fake.mode = 'healthy';
      await vi.advanceTimersByTimeAsync(700);
      expect(fake.connections).toBe(seen);
      expect(() => svc.getRedis()).toThrow(/not initialized/);
    },
  );
});
