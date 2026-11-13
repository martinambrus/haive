import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';

const ID = '11111111-2222-4333-8444-555555555555';
const h = vi.hoisted(() => ({
  userId: 'owner',
  owner: 'owner',
  providerOwner: 'owner',
  providerEnabled: true,
  containerStatus: 'stopped',
  dockerId: 'docker-id' as string | null,
  taskStatus: 'running',
  repoStatus: 'ready',
  source: 'upload',
  writable: true,
  redis: {
    scan: vi.fn(async () => ['0', []]),
    duplicate: vi.fn(() => {
      throw new Error('refusal must not start a shell');
    }),
  },
}));
vi.mock('../src/auth/jwt.js', () => ({
  verifyAccessToken: async () => ({ sub: h.userId, tv: 0 }),
}));
vi.mock('../src/redis.js', () => ({ getPatientRedis: () => h.redis }));
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      users: { findFirst: async () => ({ id: h.userId, status: 'active', tokenVersion: 0 }) },
      tasks: { findFirst: async () => ({ userId: h.owner, status: h.taskStatus }) },
      cliProviders: {
        findFirst: async () => ({ userId: h.providerOwner, enabled: h.providerEnabled }),
      },
      repositories: {
        findFirst: async () => ({
          userId: h.owner,
          status: h.repoStatus,
          source: h.source,
          writable: h.writable,
        }),
      },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () =>
            table === schema.containers
              ? [{ id: ID, taskId: ID, status: h.containerStatus, dockerContainerId: h.dockerId }]
              : [{ userId: h.owner }],
        }),
      }),
    }),
  }),
}));
import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';

let server: Server;
let port: number;
const peers = new Set<Socket>();
beforeEach(async () => {
  Object.assign(h, {
    userId: 'owner',
    owner: 'owner',
    providerOwner: 'owner',
    providerEnabled: true,
    containerStatus: 'stopped',
    dockerId: 'docker-id',
    taskStatus: 'running',
    repoStatus: 'ready',
    source: 'upload',
    writable: true,
  });
  h.redis.duplicate.mockClear();
  server = createServer();
  server.on('connection', (peer) => {
    peers.add(peer);
    peer.once('close', () => peers.delete(peer));
  });
  installTerminalWebSocket(server);
  installTerminalShellWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const peer of peers) peer.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Real handshake and close frames; HTTP refusals are recorded as status codes so
// the regression fails immediately (409), rather than waiting for a close timeout.
function connect(path: string, cookie = true, origin = 'http://localhost:3000') {
  return new Promise<{ accepted: boolean; code: number }>((resolve, reject) => {
    let accepted = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { Origin: origin, ...(cookie ? { Cookie: 'haive_access=test' } : {}) },
    });
    ws.on('open', () => {
      accepted = true;
    });
    ws.on('close', (code) => resolve({ accepted, code }));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ accepted, code: res.statusCode! });
      res.resume();
      ws.terminate();
    });
    ws.on('error', (err) => {
      if (accepted) reject(err);
    });
  });
}
const containerPath = `/terminal/${ID}`;
const taskPath = `/terminal-shell/${ID}/${ID}`;
const repoPath = `/terminal-repo-shell/${ID}/${ID}`;
describe('terminal refusal transport', () => {
  it('accepts then closes a stopped container with 4420', async () => {
    expect(await connect(containerPath)).toEqual({ accepted: true, code: 4420 });
  });
  it('accepts then closes an unbound container with 4421', async () => {
    h.containerStatus = 'running';
    h.dockerId = null;
    expect(await connect(containerPath)).toEqual({ accepted: true, code: 4421 });
  });
  it.each(['completed', 'cancelled'])('accepts then closes a %s task with 4422', async (status) => {
    h.taskStatus = status;
    expect(await connect(taskPath)).toEqual({ accepted: true, code: 4422 });
  });
  it.each([taskPath, repoPath])(
    'allows an enabled provider to request worker work: %s',
    async (path) => {
      expect(await connect(path)).toEqual({ accepted: true, code: 1011 });
      expect(h.redis.duplicate).toHaveBeenCalledOnce();
    },
  );
  it.each([taskPath, repoPath])(
    'refuses a disabled provider with 4425 before worker work: %s',
    async (path) => {
      h.providerEnabled = false;
      expect(await connect(path)).toEqual({ accepted: true, code: 4425 });
      expect(h.redis.duplicate).not.toHaveBeenCalled();
    },
  );
  it('accepts then closes a read-only repository with 4423', async () => {
    h.source = 'local_path';
    h.writable = false;
    expect(await connect(repoPath)).toEqual({ accepted: true, code: 4423 });
  });
  it('accepts then closes an unready repository with 4424', async () => {
    h.repoStatus = 'cloning';
    expect(await connect(repoPath)).toEqual({ accepted: true, code: 4424 });
  });
  for (const path of [containerPath, taskPath, repoPath]) {
    it(`refuses foreign origins before accepting ${path}`, async () => {
      expect(await connect(path, true, 'https://foreign.example')).toEqual({
        accepted: false,
        code: 403,
      });
    });
    it(`refuses unauthenticated users before accepting ${path}`, async () => {
      expect(await connect(path, false)).toEqual({ accepted: false, code: 401 });
    });
    it(`refuses another owner resource before accepting ${path}`, async () => {
      h.owner = 'someone-else';
      expect(await connect(path)).toEqual({ accepted: false, code: 404 });
    });
  }
  for (const path of [taskPath, repoPath]) {
    it(`checks provider ownership before disclosing eligibility ${path}`, async () => {
      h.providerOwner = 'someone-else';
      h.providerEnabled = false;
      h.taskStatus = 'completed';
      h.repoStatus = 'cloning';
      expect(await connect(path)).toEqual({ accepted: false, code: 404 });
    });
  }
});
