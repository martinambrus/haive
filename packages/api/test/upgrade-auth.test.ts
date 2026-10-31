import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { terminalSessionKey } from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return {
    db: undefined as unknown,
    invalidJwt: false,
    redisConnectWait: null as Promise<void> | null,
    loginReady: false,
    runtimeEnsureWait: null as Promise<{ ok: boolean }> | null,
    runtimeEnsureEntered: null as (() => void) | null,
    runtimeEnsureTimeout: 0,
    redisClients: [] as Array<{
      quit: ReturnType<typeof vi.fn>;
      subscriptions: Set<string>;
      streamKeys: Set<string>;
    }>,
    refcounts: new Map<string, number>(),
    shellSessionIds: new Map<string, string>(),
  };
});
const USER = 'abcdefab-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000003';
const BANNER = '00000000-0000-4000-8000-000000000004';
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/auth/jwt.js', async (original) => ({
  ...(await original<typeof import('../src/auth/jwt.js')>()),
  verifyAccessToken: async (token: string) => {
    if (h.invalidJwt) throw new Error('invalid');
    return {
      sub: token === 'admin-session' ? ADMIN : USER,
      role: 'user',
      tv: token === 'new-session' ? 1 : 0,
    };
  },
  signAccessToken: async () => 'new-session',
  signRefreshToken: async () => ({ token: 'new-refresh', expiresAt: new Date() }),
}));
vi.mock('../src/auth/password.js', () => ({
  hashPassword: async () => 'hash',
  verifyPassword: async () => true,
}));
vi.mock('../src/queues.js', () => ({
  getIdeEnsureQueue: () => ({
    add: async () => ({ waitUntilFinished: async () => ({ ok: true }) }),
  }),
  getIdeEnsureQueueEvents: () => ({}),
  getRuntimeEnsureQueue: () => ({
    add: async () => ({
      waitUntilFinished: async (_events: unknown, timeout: number) => {
        h.runtimeEnsureTimeout = timeout;
        h.runtimeEnsureEntered?.();
        return (await h.runtimeEnsureWait) ?? { ok: true };
      },
    }),
  }),
  getRuntimeEnsureQueueEvents: () => ({}),
  getCliExecQueue: () => ({
    add: async () => {
      let delivered = false;
      return {
        getState: async () => (delivered ? 'unknown' : 'active'),
        waitUntilFinished: () => {
          if (!h.loginReady) return new Promise(() => {});
          // Model removeOnComplete: the completed login result is delivered once.
          // Its removed job cannot supply a second result to the pending-job drain.
          if (delivered) return Promise.reject(new Error('job removed'));
          delivered = true;
          return Promise.resolve({
            ok: true,
            containerRowId: BANNER,
            dockerContainerId: 'banner-container',
          });
        },
      };
    },
  }),
  getCliExecQueueEvents: () => ({}),
}));
vi.mock('../src/redis.js', () => {
  const subscribers = new Set<EventEmitter>();
  const redis = () => {
    const emitter = new EventEmitter();
    subscribers.add(emitter);
    const observation = {
      quit: vi.fn(async () => {
        subscribers.delete(emitter);
        emitter.emit('stop');
      }),
      subscriptions: new Set<string>(),
      streamKeys: new Set<string>(),
    };
    h.redisClients.push(observation);
    return Object.assign(emitter, {
      connect: async () => {
        await h.redisConnectWait;
      },
      quit: observation.quit,
      subscribe: async (...channels: string[]) => {
        for (const channel of channels) observation.subscriptions.add(channel);
      },
      unsubscribe: async () => {},
      scan: async () => ['0', []],
      hincrby: async (key: string, field: string, increment: number) => {
        const counter = `${key}:${field}`;
        const value = (h.refcounts.get(counter) ?? 0) + increment;
        h.refcounts.set(counter, value);
        return value;
      },
      hset: async () => 1,
      get: async () => null,
      xrevrange: async () => [],
      xread: (...args: unknown[]) => {
        observation.streamKeys.add(String(args[3]));
        return new Promise((resolve) => emitter.once('stop', () => resolve(null)));
      },
      duplicate: redis,
      publish: async (channel: string, raw: string) => {
        if (channel === 'terminal:request') {
          const { correlationId, userId, scope, taskId, repositoryId, cliProviderId } =
            JSON.parse(raw);
          h.shellSessionIds.set(
            terminalSessionKey(
              userId,
              scope,
              scope === 'repo' ? repositoryId : taskId,
              cliProviderId,
            ),
            correlationId,
          );
          queueMicrotask(() => {
            for (const sub of subscribers)
              sub.emit(
                'message',
                `terminal:reply:${correlationId}`,
                JSON.stringify({
                  ok: true,
                  sessionId: correlationId,
                  containerName: 'test',
                  shell: 'bash',
                }),
              );
          });
        }
        return 0;
      },
    });
  };
  return { getRedis: redis };
});

import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';
import { installCliStreamWebSocket } from '../src/routes/cli-stream.js';
import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';
import { installIdeWebSocket } from '../src/routes/ide.js';
import { adminRoutes } from '../src/routes/admin.js';
import { userSettingsRoutes } from '../src/routes/user-settings.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { closeUserSockets } from '../src/lib/user-sockets.js';
import { upgradeListenerFiles } from './helpers/upgrade-listeners.js';

const HANDLERS = [
  { file: 'terminal', install: installTerminalWebSocket, path: `/terminal/${ID}` },
  {
    file: 'terminal-shell',
    install: installTerminalShellWebSocket,
    path: `/terminal-shell/${ID}/${ID}`,
  },
  {
    file: 'terminal-shell',
    install: installTerminalShellWebSocket,
    path: `/terminal-repo-shell/${ID}/${ID}`,
  },
  { file: 'cli-stream', install: installCliStreamWebSocket, path: `/cli-stream/${ID}` },
  {
    file: 'cli-login-banner',
    install: installCliLoginBannerWebSocket,
    path: `/cli-login-banner/${ID}`,
  },
  { file: 'browser-vnc', install: installBrowserVncWebSocket, path: `/browser-vnc/${ID}` },
  { file: 'ide', install: installIdeWebSocket, path: `/ide/${ID}/` },
  { file: 'ide', install: installIdeWebSocket, path: `/ide/repos/${ID}/` },
];
const tables = {
  users: schema.users,
  tasks: schema.tasks,
  repositories: schema.repositories,
  cliProviders: schema.cliProviders,
  cliInvocations: schema.cliInvocations,
  containers: schema.containers,
  terminalSessions: schema.terminalSessions,
  auditEvents: schema.auditEvents,
  refreshTokens: schema.refreshTokens,
};
let fake: ReturnType<typeof createFakeDb<typeof tables>>;
let server: Server;
const clients = new Set<WebSocket>();
const peers = new Set<Socket>();
const servers: Array<net.Server> = [];
const realConnect = net.connect.bind(net);
const realRequest = http.request.bind(http);

beforeEach(() => {
  h.invalidJwt = false;
  h.redisConnectWait = null;
  h.loginReady = false;
  h.runtimeEnsureWait = null;
  h.runtimeEnsureEntered = null;
  h.runtimeEnsureTimeout = 0;
  h.redisClients.length = 0;
  h.refcounts.clear();
  h.shellSessionIds.clear();
  fake = createFakeDb(tables);
  h.db = fake.db;
  fake.insert(schema.users, {
    id: USER,
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    mustChangePassword: false,
  });
  fake.insert(schema.users, { id: ADMIN, role: 'admin', status: 'active', tokenVersion: 0 });
  fake.insert(schema.tasks, { id: ID, userId: USER, status: 'running' });
  fake.insert(schema.tasks, { id: ADMIN, userId: ADMIN, status: 'running' });
  fake.insert(schema.cliInvocations, { id: ADMIN, taskId: ADMIN, steerable: false });
  fake.insert(schema.repositories, {
    id: ID,
    userId: USER,
    status: 'ready',
    source: 'upload',
    writable: true,
  });
  fake.insert(schema.cliProviders, { id: ID, userId: USER, name: 'codex' });
  fake.insert(schema.cliInvocations, { id: ID, taskId: ID, steerable: false });
  fake.insert(schema.containers, {
    id: ID,
    taskId: ID,
    status: 'running',
    dockerContainerId: 'test-container',
  });
});
afterEach(async () => {
  for (const client of clients) client.terminate();
  clients.clear();
  for (const peer of peers) peer.destroy();
  peers.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  vi.restoreAllMocks();
});
async function listen(s: net.Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}
async function start(install: (s: Server) => void): Promise<number> {
  server = createServer();
  server.on('connection', (s) => {
    peers.add(s);
    s.on('close', () => peers.delete(s));
  });
  install(server);
  return listen(server);
}
function handshake(port: number, path: string, cookie?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: cookie ? { cookie } : {},
    });
    clients.add(ws);
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      ws.terminate();
      resolve(res.statusCode!);
    });
    ws.on('error', () => {});
    ws.on('open', () => {
      ws.terminate();
      resolve(101);
    });
    setTimeout(() => reject(new Error('handshake timeout')), 2000).unref();
  });
}

describe('upgrade authentication on every surface', () => {
  for (const handler of HANDLERS) {
    describe(handler.path, () => {
      for (const condition of [
        'deactivated',
        'token-version',
        'must-change-password',
        'missing-cookie',
        'missing-user',
        'invalid-jwt',
        'malformed-cookie',
      ]) {
        it(`refuses ${condition} with 401`, async () => {
          if (condition === 'deactivated')
            fake.patch(schema.users, USER, { status: 'deactivated' });
          if (condition === 'token-version') fake.patch(schema.users, USER, { tokenVersion: 1 });
          if (condition === 'must-change-password')
            fake.patch(schema.users, USER, { mustChangePassword: true });
          if (condition === 'missing-user')
            await fake.db.delete(schema.users).where(eq(schema.users.id, USER));
          if (condition === 'invalid-jwt') h.invalidJwt = true;
          const port = await start(handler.install);
          const cookie =
            condition === 'missing-cookie'
              ? undefined
              : condition === 'malformed-cookie'
                ? 'haive_access=%'
                : 'haive_access=user-session';
          expect(await handshake(port, handler.path, cookie)).toBe(401);
        });
      }
    });
  }
  it('all upgrade routes import the one authenticator', () => {
    for (const file of upgradeListenerFiles()) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source.includes("from '../lib/upgrade-auth.js'")).toBe(true);
      expect(source.includes('function authenticateUpgrade(')).toBe(false);
      expect(source).toMatch(
        /import\s*\{[^}]*\brejectUpgrade\b[^}]*\}\s*from ['"]\.\.\/lib\/upgrade-auth\.js['"]/,
      );
      expect(source).not.toMatch(/(?:function\s+|(?:const|let|var)\s+)rejectUpgrade\b/);
    }
  });
});

async function openAll({ bannerReady = false } = {}) {
  h.loginReady = bannerReady;
  if (bannerReady)
    fake.insert(schema.containers, {
      id: BANNER,
      cliProviderId: ID,
      purpose: 'cli_login',
      status: 'running',
      dockerContainerId: 'banner-container',
    });
  const attachStreams = new Map<string, PassThrough>();
  const desktopConnections: Socket[] = [];
  const bannerContainer = {
    start: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const docker = {
    modem: { getSocketPath: () => undefined },
    getContainer: (id: string) => (id === 'banner-container' ? bannerContainer : {}),
  } as never;
  const upstream = createServer();
  const upstreamWss = new WebSocketServer({ server: upstream });
  upstream.on('connection', (s) => {
    peers.add(s);
    s.on('close', () => peers.delete(s));
  });
  const upstreamPort = await listen(upstream);
  const desktop = net.createServer((s) => {
    peers.add(s);
    s.on('close', () => peers.delete(s));
  });
  const desktopPort = await listen(desktop);
  vi.spyOn(net, 'connect').mockImplementation(((opts: net.NetConnectOpts) => {
    const o = opts as net.TcpNetConnectOpts;
    if (o.host?.startsWith('haive-ide-'))
      return realConnect({ host: '127.0.0.1', port: upstreamPort });
    if (o.port === 5900) {
      const tcp = realConnect({ host: '127.0.0.1', port: desktopPort });
      desktopConnections.push(tcp);
      return tcp;
    }
    return realConnect(opts as never);
  }) as typeof net.connect);
  vi.spyOn(http, 'request').mockImplementation(((opts: http.RequestOptions, ...args: unknown[]) => {
    const containerId = opts.path?.match(
      /^\/containers\/(test-container|banner-container)\/attach/,
    )?.[1];
    if (containerId) {
      const stream = new PassThrough();
      attachStreams.set(containerId, stream);
      const req = new EventEmitter();
      Object.assign(req, {
        end: () => queueMicrotask(() => req.emit('upgrade', {}, stream, Buffer.alloc(0))),
      });
      return req;
    }
    return Reflect.apply(realRequest, http, [opts, ...args]);
  }) as typeof http.request);
  const port = await start((s) => {
    // A Docker modem stub keeps terminal attach local and never touches a daemon.
    installTerminalWebSocket(s, { docker });
    installCliLoginBannerWebSocket(s, { docker });
    for (const handler of HANDLERS.filter(
      (h, i, a) =>
        h.file !== 'terminal' &&
        h.file !== 'cli-login-banner' &&
        a.findIndex((x) => x.file === h.file) === i,
    ))
      handler.install(s);
  });
  const result = [];
  for (const handler of HANDLERS) {
    const client = new WebSocket(`ws://127.0.0.1:${port}${handler.path}`, {
      headers: { cookie: 'haive_access=user-session' },
    });
    clients.add(client);
    const codes: number[] = [];
    client.on('close', (code) => codes.push(code));
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    result.push({ client, codes });
  }
  // Keep the local upstream server referenced until afterEach destroys its peers.
  expect(upstreamWss.clients.size).toBe(2);
  const unaffected = new WebSocket(`ws://127.0.0.1:${port}/cli-stream/${ADMIN}`, {
    headers: { cookie: 'haive_access=admin-session' },
  });
  clients.add(unaffected);
  await new Promise<void>((resolve, reject) => {
    unaffected.once('open', resolve);
    unaffected.once('error', reject);
  });
  return {
    sockets: result,
    unaffected,
    port,
    upstreamWss,
    attachStreams,
    desktopConnections,
    bannerContainer,
  };
}
const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/admin', adminRoutes);
app.route('/user-settings', userSettingsRoutes);

describe('session writers close established sockets on all surfaces', () => {
  for (const action of ['deactivate', 'reset_password', 'password']) {
    it(action, async () => {
      const { sockets, unaffected, port, upstreamWss } = await openAll();
      const response = await app.request(
        action === 'password' ? '/user-settings/password' : `/admin/users/${USER}/action`,
        {
          method: action === 'password' ? 'PUT' : 'POST',
          headers: {
            'content-type': 'application/json',
            cookie:
              action === 'password' ? 'haive_access=user-session' : 'haive_access=admin-session',
          },
          body: JSON.stringify(
            action === 'password'
              ? { currentPassword: 'Old-password-1!', newPassword: 'New-password-2!' }
              : { action },
          ),
        },
      );
      expect(response.status).toBe(200);
      await vi.waitFor(
        () => expect(sockets.map((s) => s.codes)).toEqual(HANDLERS.map(() => [1008])),
        { timeout: 1500 },
      );
      expect(unaffected.readyState).toBe(WebSocket.OPEN);
      await vi.waitFor(() => expect(upstreamWss.clients.size).toBe(0));
      expect(await handshake(port, `/cli-stream/${ID}`, 'haive_access=user-session')).toBe(401);
      if (action === 'password')
        expect(await handshake(port, `/cli-stream/${ID}`, 'haive_access=new-session')).toBe(101);
    });
  }
});

function deactivate() {
  return app.request(`/admin/users/${USER}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'haive_access=admin-session' },
    body: JSON.stringify({ action: 'deactivate' }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('revocation ordering', () => {
  it('keeps established sockets when the admin transaction rolls back', async () => {
    const { sockets, unaffected } = await openAll();
    fake.hooks.beforeCommit = () => {
      throw new Error('commit refused');
    };
    expect((await deactivate()).status).toBe(500);
    expect(fake.rows(schema.users).find((u) => u.id === USER)?.status).toBe('active');
    expect(sockets.map((s) => s.client.readyState)).toEqual(HANDLERS.map(() => WebSocket.OPEN));
    expect(unaffected.readyState).toBe(WebSocket.OPEN);
  });

  for (const stage of ['authentication', 'ownership'] as const) {
    it(`fences an upgrade suspended during ${stage}`, async () => {
      const captured = deferred<void>();
      const resume = deferred<void>();
      const table = stage === 'authentication' ? fake.db.query.users : fake.db.query.tasks;
      const original = table.findFirst.bind(table);
      vi.spyOn(table, 'findFirst').mockImplementationOnce(async (opts) => {
        const snapshot = await original(opts);
        captured.resolve();
        await resume.promise;
        return snapshot;
      });
      const port = await start(installCliStreamWebSocket);
      const pending = handshake(port, `/cli-stream/${ID}`, 'haive_access=user-session');
      await captured.promise;
      expect((await deactivate()).status).toBe(200);
      expect(await pending).toBe(401);
      resume.resolve();
      await new Promise<void>((r) => setImmediate(r));
    });
  }

  it('closes an IDE pending its upstream upgrade as HTTP 401 and tears down the upstream', async () => {
    const arrived = deferred<void>();
    const gone = deferred<void>();
    const upstream = createServer();
    upstream.on('upgrade', (_req, socket) => {
      socket.resume();
      socket.on('end', () => socket.end());
      socket.on('close', () => gone.resolve());
      peers.add(socket as Socket);
      socket.on('close', () => peers.delete(socket as Socket));
      arrived.resolve();
    });
    const upstreamPort = await listen(upstream);
    vi.spyOn(net, 'connect').mockImplementation(((opts: net.TcpNetConnectOpts) => {
      if (opts.host?.startsWith('haive-ide-'))
        return realConnect({ host: '127.0.0.1', port: upstreamPort });
      return realConnect(opts);
    }) as typeof net.connect);
    const port = await start(installIdeWebSocket);
    const pending = handshake(port, `/ide/${ID}/`, 'haive_access=user-session');
    await arrived.promise;
    expect((await deactivate()).status).toBe(200);
    expect(await pending).toBe(401);
    await gone.promise;
  });
});

describe('fix round admin controls', () => {
  for (const action of ['deactivate', 'reset_password']) {
    it(`uppercase id ${action} closes the selected user's socket`, async () => {
      const { sockets } = await openAll();
      // The fake compares UUID values as PostgreSQL does, so the upper-case param reaches the
      // selected row and the sockets are closed by its canonical id.
      const response = await app.request(`/admin/users/${USER.toUpperCase()}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'haive_access=admin-session' },
        body: JSON.stringify({ action }),
      });
      expect(response.status).toBe(200);
      await vi.waitFor(
        () => expect(sockets.map((s) => s.codes)).toEqual(HANDLERS.map(() => [1008])),
        { timeout: 1500 },
      );
    });
  }

  it('activate leaves established sockets open', async () => {
    const { sockets } = await openAll();
    const response = await app.request(`/admin/users/${USER}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'haive_access=admin-session' },
      body: JSON.stringify({ action: 'activate' }),
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sockets.map((s) => s.client.readyState)).toEqual(HANDLERS.map(() => WebSocket.OPEN));
  });
});

// Every handler spends time in this DB await, before ws/IDE has installed transport handlers.
describe('upgrade transport controls', () => {
  for (const handler of HANDLERS) {
    it(`survives a reset during authentication on ${handler.path}`, async () => {
      const captured = deferred<void>();
      const resume = deferred<void>();
      const findFirst = fake.db.query.users.findFirst.bind(fake.db.query.users);
      vi.spyOn(fake.db.query.users, 'findFirst').mockImplementationOnce(async (opts) => {
        captured.resolve();
        await resume.promise;
        return findFirst(opts);
      });
      const port = await start(handler.install);
      const client = net.connect(port, '127.0.0.1');
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.write(
        `GET ${handler.path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: haive_access=user-session\r\n\r\n`,
      );
      await captured.promise;
      const peer = [...peers][0]!;
      const closed = new Promise<void>((resolve) => peer.once('close', () => resolve()));
      client.resetAndDestroy();
      await closed;
      resume.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(peer.destroyed).toBe(true);
    });
  }
});

describe('accepted websocket transport controls', () => {
  for (const [index, handler] of HANDLERS.entries()) {
    if (handler.file === 'ide') continue; // IDE relays bytes to code-server; it owns no ws parser.
    it(`invalid UTF-8 closes only ${handler.path}`, async () => {
      const setup = deferred<void>();
      h.redisConnectWait = setup.promise;
      const { sockets, unaffected } = await openAll();
      const target = sockets[index]!;
      target.client.send(Buffer.from([0xc0, 0xaf]), { binary: false });
      await vi.waitFor(() => expect(target.codes).toEqual([1007]));
      expect(unaffected.readyState).toBe(WebSocket.OPEN);
      expect(
        sockets.filter((_, i) => i !== index).every((s) => s.client.readyState === WebSocket.OPEN),
      ).toBe(true);
      setup.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  }
});

describe('real transport registry cleanup controls', () => {
  it('normal closes remove every registered session', async () => {
    const { sockets } = await openAll();
    for (const { client } of sockets) client.close(1000);
    await vi.waitFor(() =>
      expect(sockets.every((s) => s.client.readyState === WebSocket.CLOSED)).toBe(true),
    );
    expect(closeUserSockets(USER)).toBe(0);
  });

  it('a refused authenticated handshake leaves the registry empty', async () => {
    fake.patch(schema.users, USER, { mustChangePassword: true });
    const port = await start(installCliStreamWebSocket);
    expect(await handshake(port, `/cli-stream/${ID}`, 'haive_access=user-session')).toBe(401);
    expect(closeUserSockets(USER)).toBe(0);
  });
});

describe('terminal replay ordering', () => {
  it('sends connected before output buffered by the attach stream', async () => {
    const stream = new PassThrough();
    stream.write('replayed output\n');
    vi.spyOn(http, 'request').mockImplementation(((
      opts: http.RequestOptions,
      ...args: unknown[]
    ) => {
      if (!opts.path?.startsWith('/containers/test-container/attach'))
        return Reflect.apply(realRequest, http, [opts, ...args]);
      const req = new EventEmitter();
      Object.assign(req, {
        end: () => queueMicrotask(() => req.emit('upgrade', {}, stream, Buffer.alloc(0))),
      });
      return req;
    }) as typeof http.request);
    // Model a database round trip so buffered data can flow across the await.
    fake.hooks.beforeUpdate = async (table) => {
      if (table === schema.containers) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const docker = {
      modem: { getSocketPath: () => undefined },
      getContainer: () => ({}),
    } as never;
    const port = await start((s) => installTerminalWebSocket(s, { docker }));
    const client = new WebSocket(`ws://127.0.0.1:${port}/terminal/${ID}`, {
      headers: { cookie: 'haive_access=user-session' },
    });
    clients.add(client);
    const frames: Array<{ type: string; data?: string }> = [];
    client.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    try {
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[0]?.type).toBe('connected');
      expect(frames[1]).toEqual({ type: 'output', data: 'replayed output\n' });
    } finally {
      client.close();
      await vi.waitFor(() => expect(stream.writableEnded).toBe(true));
      stream.destroy();
    }
  });
});

describe('terminal startup failure cleanup', () => {
  for (const stage of ['attach', 'setup'] as const) {
    it(`cleans up once when the websocket is not OPEN after ${stage}`, async () => {
      fake.patch(schema.containers, ID, { attachedWsCount: 1 });
      const stream = new PassThrough();
      let accepted!: WebSocket;
      const upgrade = WebSocketServer.prototype.handleUpgrade;
      vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation(function (
        this: WebSocketServer,
        req,
        socket,
        head,
        callback,
      ) {
        upgrade.call(this, req, socket, head, (ws, request) => {
          accepted = ws;
          callback(ws, request);
        });
      });
      // Hold the transport in CLOSING without emitting close: each not-OPEN branch
      // must release its own resources before the eventual close callback runs.
      const closing = () =>
        Object.defineProperty(accepted, 'readyState', {
          configurable: true,
          value: WebSocket.CLOSING,
        });
      vi.spyOn(http, 'request').mockImplementation(((
        opts: http.RequestOptions,
        ...args: unknown[]
      ) => {
        if (!opts.path?.startsWith('/containers/test-container/attach'))
          return Reflect.apply(realRequest, http, [opts, ...args]);
        const req = new EventEmitter();
        Object.assign(req, {
          end: () =>
            queueMicrotask(() => {
              if (stage === 'attach') closing();
              req.emit('upgrade', {}, stream, Buffer.alloc(0));
            }),
        });
        return req;
      }) as typeof http.request);
      const intervals: Array<ReturnType<typeof setInterval>> = [];
      const interval = globalThis.setInterval;
      const clear = vi.spyOn(globalThis, 'clearInterval');
      if (stage === 'setup') {
        vi.spyOn(globalThis, 'setInterval').mockImplementation(((
          ...args: Parameters<typeof setInterval>
        ) => {
          expect(fake.rows(schema.containers)[0]?.attachedWsCount).toBe(2);
          intervals.push(interval(...args));
          if (intervals.length === 2) closing();
          return intervals.at(-1)!;
        }) as typeof setInterval);
      }
      const docker = {
        modem: { getSocketPath: () => undefined },
        getContainer: () => ({}),
      } as never;
      const port = await start((s) => installTerminalWebSocket(s, { docker }));
      const client = new WebSocket(`ws://127.0.0.1:${port}/terminal/${ID}`, {
        headers: { cookie: 'haive_access=user-session' },
      });
      clients.add(client);
      const frames: unknown[] = [];
      client.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      try {
        await vi.waitFor(() => {
          expect(stream.writableEnded).toBe(true);
          expect(fake.rows(schema.containers)[0]?.attachedWsCount).toBe(1);
          const sessions = fake.rows(schema.terminalSessions);
          expect(sessions).toHaveLength(stage === 'attach' ? 0 : 1);
          for (const session of sessions) expect(session.endedAt).toBeInstanceOf(Date);
        });
        expect(frames).toEqual([]);
        for (const timer of intervals) expect(clear).toHaveBeenCalledWith(timer);
      } finally {
        if (accepted) Reflect.deleteProperty(accepted, 'readyState');
        client.close();
        await new Promise<void>((resolve) => client.once('close', () => resolve()));
        // The later close listener must not decrement a second time.
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const timer of intervals) clearInterval(timer);
        stream.destroy();
      }
      expect(fake.rows(schema.containers)[0]?.attachedWsCount).toBe(1);
    });
  }

  for (const { stage, bound } of [
    { stage: 'increment', bound: false },
    { stage: 'timers', bound: false },
    { stage: 'increment', bound: true },
    { stage: 'timers', bound: true },
  ] as const) {
    it(`${bound ? 'bound error: ' : ''}ends the attach stream and closes the websocket when ${stage} fails`, async () => {
      fake.patch(schema.containers, ID, { attachedWsCount: 1 });
      const stream = new PassThrough();
      vi.spyOn(http, 'request').mockImplementation(((
        opts: http.RequestOptions,
        ...args: unknown[]
      ) => {
        if (!opts.path?.startsWith('/containers/test-container/attach'))
          return Reflect.apply(realRequest, http, [opts, ...args]);
        const req = new EventEmitter();
        Object.assign(req, {
          end: () => queueMicrotask(() => req.emit('upgrade', {}, stream, Buffer.alloc(0))),
        });
        return req;
      }) as typeof http.request);
      const failure = bound
        ? new DrizzleQueryError(
            'update containers set attached_ws_count = $1',
            ['synthetic-bound-private-value'],
            new Error('synthetic-bound-private-value'),
          )
        : new Error(`${stage} unavailable`);
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const clear = vi.spyOn(globalThis, 'clearInterval');
      if (stage === 'increment') {
        vi.spyOn(fake.db, 'update').mockImplementationOnce(() => {
          expect(fake.rows(schema.containers)[0]?.attachedWsCount).toBe(1);
          throw failure;
        });
      } else {
        const interval = globalThis.setInterval;
        vi.spyOn(globalThis, 'setInterval')
          .mockImplementationOnce(((...args: Parameters<typeof setInterval>) => {
            keepalive = interval(...args);
            return keepalive;
          }) as typeof setInterval)
          .mockImplementationOnce(() => {
            expect(fake.rows(schema.containers)[0]?.attachedWsCount).toBe(2);
            throw failure;
          });
      }
      const docker = {
        modem: { getSocketPath: () => undefined },
        getContainer: () => ({}),
      } as never;
      const port = await start((s) => installTerminalWebSocket(s, { docker }));
      const client = new WebSocket(`ws://127.0.0.1:${port}/terminal/${ID}`, {
        headers: { cookie: 'haive_access=user-session' },
      });
      clients.add(client);
      const frames: unknown[] = [];
      client.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      const closed = new Promise<number>((resolve, reject) => {
        client.once('close', resolve);
        client.once('error', reject);
      });
      try {
        expect(await closed).toBe(1011);
        const errorFrame = {
          type: 'error',
          message: bound ? 'Database operation failed' : failure.message,
        };
        expect(frames.some((frame) => JSON.stringify(frame) === JSON.stringify(errorFrame))).toBe(
          true,
        );
        expect(JSON.stringify(frames).includes('synthetic-bound-private-value')).toBe(false);
        expect(stream.writableEnded).toBe(true);
        await vi.waitFor(() => {
          expect(fake.rows(schema.containers)[0]?.attachedWsCount).toBe(1);
          const sessions = fake.rows(schema.terminalSessions);
          expect(sessions).toHaveLength(stage === 'increment' ? 0 : 1);
          for (const session of sessions) expect(session.endedAt).toBeInstanceOf(Date);
        });
        if (keepalive) expect(clear).toHaveBeenCalledWith(keepalive);
      } finally {
        // Also bound the timer in the red control, before production cleanup exists.
        if (keepalive) clearInterval(keepalive);
        stream.destroy();
      }
    });
  }
});

describe('revocation resource teardown', () => {
  async function revoke(sockets: Awaited<ReturnType<typeof openAll>>['sockets']) {
    expect((await deactivate()).status).toBe(200);
    await vi.waitFor(() => expect(sockets.map((s) => s.codes)).toEqual(HANDLERS.map(() => [1008])));
  }

  it('ends the terminal Docker attach stream', async () => {
    const { sockets, attachStreams } = await openAll();
    const stream = attachStreams.get('test-container')!;
    expect(stream.writableEnded).toBe(false);
    await revoke(sockets);
    await vi.waitFor(() => expect(stream.writableEnded).toBe(true));
  });

  it('releases the terminal attach count', async () => {
    const { sockets } = await openAll();
    const count = () => fake.rows(schema.containers).find((c) => c.id === ID)?.attachedWsCount;
    await vi.waitFor(() => expect(count()).toBe(1));
    await revoke(sockets);
    await vi.waitFor(() => expect(count()).toBe(0));
  });

  for (const scope of ['task', 'repo'] as const) {
    it(`quits the ${scope} shell subscriber and releases its refcount`, async () => {
      const { sockets } = await openAll();
      const counter = `${terminalSessionKey(USER, scope, ID, ID)}:refcount`;
      await vi.waitFor(() => expect(h.refcounts.get(counter)).toBe(1));
      const sessionId = h.shellSessionIds.get(terminalSessionKey(USER, scope, ID, ID));
      expect(sessionId).toBeDefined();
      const subscribers = h.redisClients.filter((c) =>
        c.subscriptions.has(`terminal:out:${sessionId}`),
      );
      expect(subscribers).toHaveLength(1);
      const subscriber = subscribers[0]!;
      expect(subscriber.quit).not.toHaveBeenCalled();
      await revoke(sockets);
      await vi.waitFor(() => {
        expect(subscriber.quit).toHaveBeenCalledOnce();
        expect(h.refcounts.get(counter)).toBe(0);
      });
    });
  }

  it('quits the dedicated cli-stream Redis client', async () => {
    const { sockets } = await openAll();
    const readers = h.redisClients.filter((c) => c.streamKeys.has(`cli-stream:${ID}`));
    expect(readers).toHaveLength(1);
    const reader = readers[0]!;
    expect(reader.quit).not.toHaveBeenCalled();
    await revoke(sockets);
    await vi.waitFor(() => expect(reader.quit).toHaveBeenCalledOnce());
    const other = h.redisClients.find((c) => c.streamKeys.has(`cli-stream:${ADMIN}`))!;
    expect(other.quit).not.toHaveBeenCalled();
  });

  it('destroys the completed banner login container', async () => {
    const { sockets, attachStreams, bannerContainer } = await openAll({ bannerReady: true });
    await vi.waitFor(() => expect(bannerContainer.start).toHaveBeenCalledOnce());
    expect(attachStreams.get('banner-container')!.writableEnded).toBe(false);
    expect(bannerContainer.remove).not.toHaveBeenCalled();
    await revoke(sockets);
    await vi.waitFor(() => expect(bannerContainer.remove).toHaveBeenCalledWith({ force: true }));
  });

  it('destroys the VNC bridge TCP socket', async () => {
    const { sockets, desktopConnections } = await openAll();
    // The fast-path probe is destroyed before upgrading; the bridge is a separate socket.
    expect(desktopConnections).toHaveLength(2);
    const tcp = desktopConnections[1]!;
    expect(tcp.destroyed).toBe(false);
    await revoke(sockets);
    await vi.waitFor(() => expect(tcp.destroyed).toBe(true));
  });
});

describe('pending runtime upgrade fences', () => {
  it('revokes VNC during the ensure wait with 401 and starts no bridge', async () => {
    const arrived = deferred<void>();
    const resume = deferred<{ ok: boolean }>();
    const resolvedDesktop = deferred<void>();
    h.runtimeEnsureEntered = arrived.resolve;
    h.runtimeEnsureWait = resume.promise;
    let probes = 0;
    vi.spyOn(net, 'connect').mockImplementation(((opts: net.TcpNetConnectOpts) => {
      if (opts.port !== 5900) return realConnect(opts);
      probes += 1;
      const number = probes;
      // Both cold-runtime probes fail; after ensure completes the desktop is reachable.
      const tcp = new EventEmitter() as Socket;
      Object.assign(tcp, {
        setTimeout: () => tcp,
        destroy: () => {
          if (number === 3) resolvedDesktop.resolve();
          return tcp;
        },
      });
      queueMicrotask(() => tcp.emit(number <= 2 ? 'error' : 'connect', new Error('unavailable')));
      return tcp;
    }) as typeof net.connect);
    const upgrade = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade');
    const port = await start(installBrowserVncWebSocket);
    const pending = handshake(port, `/browser-vnc/${ID}`, 'haive_access=user-session');
    await arrived.promise;
    expect(probes).toBe(2);
    expect(h.runtimeEnsureTimeout).toBe(180_000);
    expect((await deactivate()).status).toBe(200);
    expect(await pending).toBe(401);
    resume.resolve({ ok: true });
    await resolvedDesktop.promise;
    await new Promise<void>((r) => setImmediate(r));
    expect(upgrade.mock.calls.length).toBe(0);
    expect(probes).toBe(3);
    expect(closeUserSockets(USER)).toBe(0);
  });

  it('revokes terminal during the container wait with 401 and starts no session', async () => {
    const arrived = deferred<void>();
    const resume = deferred<void>();
    const select = fake.db.select.bind(fake.db);
    vi.spyOn(fake.db, 'select').mockImplementationOnce((fields) => ({
      from: (table) => {
        expect(table).toBe(schema.containers);
        const query = select(fields).from(table);
        const then = query.then.bind(query);
        query.then = (onFulfilled, onRejected) =>
          then(async (snapshot) => {
            arrived.resolve();
            await resume.promise;
            return snapshot;
          }).then(onFulfilled, onRejected);
        return query;
      },
    }));
    const upgrade = vi.spyOn(WebSocketServer.prototype, 'handleUpgrade');
    const getContainer = vi.fn();
    const port = await start((s) =>
      installTerminalWebSocket(s, { docker: { getContainer } as never }),
    );
    const pending = handshake(port, `/terminal/${ID}`, 'haive_access=user-session');
    await arrived.promise;
    expect((await deactivate()).status).toBe(200);
    expect(await pending).toBe(401);
    resume.resolve();
    await new Promise<void>((r) => setImmediate(r));
    expect(upgrade.mock.calls.length).toBe(0);
    expect(getContainer).not.toHaveBeenCalled();
    expect(fake.rows(schema.terminalSessions)).toHaveLength(0);
    expect(fake.rows(schema.containers)[0]?.attachedWsCount ?? 0).toBe(0);
    expect(closeUserSockets(USER)).toBe(0);
  });
});
