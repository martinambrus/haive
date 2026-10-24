import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

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
    return { sub: token === 'admin-session' ? ADMIN : USER, role: 'user', tv: 0 };
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
  const redis = () => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      connect: async () => {},
      quit: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
      scan: async () => ['0', []],
      hincrby: async () => 1,
      hset: async () => 1,
      get: async () => null,
      xrevrange: async () => [],
      xread: () => new Promise((resolve) => emitter.once('stop', () => resolve(null))),
      duplicate: redis,
      publish: async () => 0,
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

export const HANDLERS = [
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
            await fake.db
              .delete(schema.users)
              .where((await import('drizzle-orm')).eq(schema.users.id, USER));
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
