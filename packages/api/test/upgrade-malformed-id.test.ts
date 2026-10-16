import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => {
  const error = vi.fn();
  const quiet = vi.fn();
  const logger: Record<string, unknown> = {
    error,
    warn: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    fatal: quiet,
  };
  logger.child = () => logger;
  const redis = {
    scan: async () => ['0', []],
    xrevrange: async () => [],
    duplicate: () => ({
      connect: async () => undefined,
      xread: () => new Promise((resolve) => setTimeout(() => resolve(null), 10)),
      quit: async () => undefined,
    }),
  };
  return {
    USER: '00000000-0000-4000-8000-0000000000a1',
    db: undefined as unknown,
    dbCalls: 0,
    error,
    logger,
    redis,
  };
});

vi.mock('../src/db.js', () => ({
  getDb: () => {
    h.dbCalls += 1;
    return h.db;
  },
}));
vi.mock('../src/auth/jwt.js', () => ({
  verifyAccessToken: async () => ({ sub: h.USER, role: 'user', tv: 0 }),
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => h.redis }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: h.logger,
}));

import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';
import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { installCliStreamWebSocket } from '../src/routes/cli-stream.js';
import { installIdeWebSocket } from '../src/routes/ide.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';
import { installTerminalWebSocket } from '../src/routes/terminal.js';

const TASK = '00000000-0000-4000-8000-0000000000c1';
const ENDED_TASK = '00000000-0000-4000-8000-0000000000c2';
const REPOSITORY = '00000000-0000-4000-8000-0000000000b1';
const INVOCATION = '00000000-0000-4000-8000-0000000000d1';
const CONTAINER = '00000000-0000-4000-8000-0000000000e1';
const PROVIDER = '00000000-0000-4000-8000-0000000000f1';

// What each handler does with an id it finds and the user owns, short of starting a session.
const HELD = [
  {
    name: 'cli-stream',
    install: installCliStreamWebSocket,
    prefix: '/cli-stream/',
    id: INVOCATION,
    status: 'HTTP/1.1 101 Switching Protocols',
  },
  {
    name: 'terminal',
    install: installTerminalWebSocket,
    prefix: '/terminal/',
    id: CONTAINER,
    status: 'HTTP/1.1 409 Container not running',
  },
  {
    name: 'cli-login-banner',
    install: installCliLoginBannerWebSocket,
    prefix: '/cli-login-banner/',
    id: PROVIDER,
    status: 'HTTP/1.1 400 Login Unsupported',
  },
];
const HANDLERS = [
  ...HELD,
  { name: 'browser-vnc', install: installBrowserVncWebSocket, prefix: '/browser-vnc/' },
  { name: 'ide', install: installIdeWebSocket, prefix: '/ide/' },
];
const MALFORMED = ['abc', 'a'.repeat(36), '-'.repeat(36), `${TASK}0`];
const SHELLS = [
  {
    name: 'terminal-shell',
    prefix: '/terminal-shell/',
    held: ENDED_TASK,
    status: 'HTTP/1.1 409 Task is completed - terminal disabled',
  },
  {
    name: 'terminal-repo-shell',
    prefix: '/terminal-repo-shell/',
    held: REPOSITORY,
    status: 'HTTP/1.1 409 Repository is cloning - terminal unavailable',
  },
];

let server: Server | null = null;

beforeEach(() => {
  h.dbCalls = 0;
  h.error.mockClear();
  const fake = createFakeDb({
    users: schema.users,
    tasks: schema.tasks,
    repositories: schema.repositories,
    cliInvocations: schema.cliInvocations,
    cliProviders: schema.cliProviders,
    containers: schema.containers,
  });
  fake.insert(schema.users, { id: h.USER, status: 'active', tokenVersion: 0 });
  fake.insert(schema.tasks, { id: TASK, userId: h.USER });
  fake.insert(schema.tasks, { id: ENDED_TASK, userId: h.USER, status: 'completed' });
  fake.insert(schema.repositories, { id: REPOSITORY, userId: h.USER, status: 'cloning' });
  fake.insert(schema.cliInvocations, {
    id: INVOCATION,
    taskId: TASK,
    steerable: false,
    startedAt: null,
  });
  fake.insert(schema.cliProviders, { id: PROVIDER, userId: h.USER, name: 'gemini' });
  fake.insert(schema.containers, {
    id: CONTAINER,
    status: 'stopped',
    purpose: 'cli_login',
    cliProviderId: PROVIDER,
  });
  h.db = fake.db;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function listen(install: (s: Server) => void): Promise<number> {
  server = createServer();
  install(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** The status line a signed-in raw WebSocket handshake gets back. */
function handshake(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Cookie: ${ACCESS_COOKIE}=token`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) {
        resolve(data.split('\r\n')[0] ?? '');
        socket.destroy();
      }
    });
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

describe.each(HANDLERS)('the $name upgrade', ({ install, prefix }) => {
  it.each(MALFORMED)(
    'answers the malformed id %j with 404, before any database read and without an error log',
    async (id) => {
      const port = await listen(install);

      expect(await handshake(port, `${prefix}${id}`)).toBe('HTTP/1.1 404 Not Found');
      expect(h.dbCalls).toBe(0);
      expect(h.error).not.toHaveBeenCalled();
    },
  );

  it('answers a well-formed id nobody holds with 404, after reading the database (passes before and after)', async () => {
    const port = await listen(install);

    expect(await handshake(port, `${prefix}${randomUUID()}`)).toBe('HTTP/1.1 404 Not Found');
    expect(h.dbCalls).toBeGreaterThan(0);
    expect(h.error).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: 'browser-vnc', install: installBrowserVncWebSocket, prefix: '/browser-vnc/' },
  { name: 'ide', install: installIdeWebSocket, prefix: '/ide/' },
])('the $name upgrade, whose id names a container', ({ install, prefix }) => {
  it('answers an uppercase uuid with 404 before any database read, as it always did', async () => {
    const port = await listen(install);

    expect(await handshake(port, `${prefix}${randomUUID().toUpperCase()}`)).toBe(
      'HTTP/1.1 404 Not Found',
    );
    expect(h.dbCalls).toBe(0);
    expect(h.error).not.toHaveBeenCalled();
  });
});

describe.each(HELD)(
  'the $name upgrade, an id the user holds',
  ({ install, prefix, id, status }) => {
    it('goes on to the handler it always did (passes before and after)', async () => {
      const port = await listen(install);

      expect(await handshake(port, `${prefix}${id}`)).toBe(status);
      expect(h.dbCalls).toBeGreaterThan(0);
      expect(h.error).not.toHaveBeenCalled();
    });
  },
);

describe.each(SHELLS)('the $name upgrade', ({ prefix, held, status }) => {
  const malformed = MALFORMED.flatMap((id) => [`${id}/${PROVIDER}`, `${held}/${id}`]);

  it.each(malformed)(
    'answers the malformed ids %s with 404, before any database read and without an error log',
    async (ids) => {
      const port = await listen(installTerminalShellWebSocket);

      expect(await handshake(port, `${prefix}${ids}`)).toBe('HTTP/1.1 404 Not Found');
      expect(h.dbCalls).toBe(0);
      expect(h.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    [held.toUpperCase(), PROVIDER],
    [held, PROVIDER.toUpperCase()],
  ])(
    'answers the uppercase ids %s/%s with 404 before any database read, since an id names a container',
    async (scope, provider) => {
      const port = await listen(installTerminalShellWebSocket);

      expect(await handshake(port, `${prefix}${scope}/${provider}`)).toBe('HTTP/1.1 404 Not Found');
      expect(h.dbCalls).toBe(0);
      expect(h.error).not.toHaveBeenCalled();
    },
  );

  it('answers well-formed ids nobody holds with 404, after reading the database (passes before and after)', async () => {
    const port = await listen(installTerminalShellWebSocket);
    const path = `${prefix}${randomUUID()}/${randomUUID()}`;

    expect(await handshake(port, path)).toBe('HTTP/1.1 404 Not Found');
    expect(h.dbCalls).toBeGreaterThan(0);
    expect(h.error).not.toHaveBeenCalled();
  });

  it('goes on to the handler it always did for ids the user holds (passes before and after)', async () => {
    const port = await listen(installTerminalShellWebSocket);

    expect(await handshake(port, `${prefix}${held}/${PROVIDER}`)).toBe(status);
    expect(h.dbCalls).toBeGreaterThan(0);
    expect(h.error).not.toHaveBeenCalled();
  });
});
