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
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../src/context.js';

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return { db: undefined as unknown, invalidJwt: false };
});
const USER = '00000000-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000003';
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
  getCliExecQueue: () => ({
    add: async () => ({
      getState: async () => 'active',
      waitUntilFinished: () => new Promise(() => {}),
    }),
  }),
  getCliExecQueueEvents: () => ({}),
}));
vi.mock('../src/redis.js', () => {
  const subscribers = new Set<EventEmitter>();
  const redis = () => {
    const emitter = new EventEmitter();
    subscribers.add(emitter);
    return Object.assign(emitter, {
      connect: async () => {},
      quit: async () => {
        subscribers.delete(emitter);
        emitter.emit('stop');
      },
      subscribe: async () => {},
      unsubscribe: async () => {},
      scan: async () => ['0', []],
      hincrby: async () => 1,
      hset: async () => 1,
      get: async () => null,
      xrevrange: async () => [],
      xread: () => new Promise((resolve) => emitter.once('stop', () => resolve(null))),
      duplicate: redis,
      publish: async (channel: string, raw: string) => {
        if (channel === 'terminal:request') {
          const { correlationId } = JSON.parse(raw);
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
  it('all six routes import the one authenticator', () => {
    for (const file of new Set(HANDLERS.map((h) => h.file))) {
      const source = readFileSync(new URL(`../src/routes/${file}.ts`, import.meta.url), 'utf8');
      expect(source.includes("from '../lib/upgrade-auth.js'")).toBe(true);
      expect(source.includes('function authenticateUpgrade(')).toBe(false);
    }
  });
});

async function openAll() {
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
    if (o.port === 5900) return realConnect({ host: '127.0.0.1', port: desktopPort });
    return realConnect(opts as never);
  }) as typeof net.connect);
  vi.spyOn(http, 'request').mockImplementation(((opts: http.RequestOptions, ...args: unknown[]) => {
    if (opts.path?.startsWith('/containers/test-container/attach')) {
      const req = new EventEmitter();
      Object.assign(req, {
        end: () =>
          queueMicrotask(() => req.emit('upgrade', {}, new PassThrough(), Buffer.alloc(0))),
      });
      return req;
    }
    return Reflect.apply(realRequest, http, [opts, ...args]);
  }) as typeof http.request);
  const port = await start((s) => {
    // A Docker modem stub keeps terminal attach local and never touches a daemon.
    installTerminalWebSocket(s, {
      docker: { modem: { getSocketPath: () => undefined }, getContainer: () => ({}) } as never,
    });
    for (const handler of HANDLERS.filter(
      (h, i, a) => h.file !== 'terminal' && a.findIndex((x) => x.file === h.file) === i,
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
  return { sockets: result, unaffected, port, upstreamWss };
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
