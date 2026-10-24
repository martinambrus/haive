import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return { db: undefined as unknown };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({
  getRedis: () => {
    throw new Error('redis is not reachable in this test');
  },
  getBullRedis: () => {
    throw new Error('redis is not reachable in this test');
  },
}));
vi.mock('../src/queues.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/queues.js')>();
  return Object.fromEntries(
    Object.keys(real).map((name) => [
      name,
      () => {
        throw new Error(`${name} is not reachable in this test`);
      },
    ]),
  );
});

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { secretsService } from '@haive/shared';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';
import { installCliStreamWebSocket } from '../src/routes/cli-stream.js';
import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';
import { installIdeWebSocket } from '../src/routes/ide.js';

const ID = '11111111-2222-3333-4444-555555555555';
const FLAGGED = '00000000-0000-4000-8000-0000000000f1';
const UNFLAGGED = '00000000-0000-4000-8000-0000000000f2';

// Each unflagged case ends at the handler's own ownership check, which answers 404 for a target
// the user does not own; that is the proof that authentication itself passed.
const HANDLERS: Array<{ file: string; install: (s: Server) => void; path: string }> = [
  { file: 'routes/terminal.ts', install: installTerminalWebSocket, path: `/terminal/${ID}` },
  {
    file: 'routes/terminal-shell.ts',
    install: installTerminalShellWebSocket,
    path: `/terminal-shell/${ID}/${ID}`,
  },
  { file: 'routes/cli-stream.ts', install: installCliStreamWebSocket, path: `/cli-stream/${ID}` },
  {
    file: 'routes/cli-login-banner.ts',
    install: installCliLoginBannerWebSocket,
    path: `/cli-login-banner/${ID}`,
  },
  {
    file: 'routes/browser-vnc.ts',
    install: installBrowserVncWebSocket,
    path: `/browser-vnc/${ID}`,
  },
  { file: 'routes/ide.ts', install: installIdeWebSocket, path: `/ide/${ID}/` },
];

let server: Server | null = null;

beforeEach(() => {
  const fake = createFakeDb({
    users: schema.users,
    containers: schema.containers,
    tasks: schema.tasks,
    cliProviders: schema.cliProviders,
    cliInvocations: schema.cliInvocations,
    repositories: schema.repositories,
  });
  fake.insert(schema.users, {
    id: FLAGGED,
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    mustChangePassword: true,
  });
  fake.insert(schema.users, {
    id: UNFLAGGED,
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    mustChangePassword: false,
  });
  h.db = fake.db;
  vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function listen(install: (s: Server) => void): Promise<number> {
  server = createServer();
  install(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function handshake(port: number, path: string, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        `Cookie: ${cookie}`,
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

const cookieFor = async (sub: string) =>
  `${ACCESS_COOKIE}=${await signAccessToken({ sub, role: 'user', tv: 0 })}`;

describe('a WebSocket handshake from a user who must change their password', () => {
  for (const handler of HANDLERS) {
    it(`is refused with 401 (${handler.file})`, async () => {
      const port = await listen(handler.install);
      expect(await handshake(port, handler.path, await cookieFor(FLAGGED))).toBe(
        'HTTP/1.1 401 Unauthorized',
      );
    });

    it(`from a user who has no such flag passes authentication and stops at ownership (${handler.file})`, async () => {
      const port = await listen(handler.install);
      expect(await handshake(port, handler.path, await cookieFor(UNFLAGGED))).toBe(
        'HTTP/1.1 404 Not Found',
      );
    });
  }
});
