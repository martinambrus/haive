import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { beforeEach, expect, it, vi } from 'vitest';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';

const TASK = '11111111-2222-3333-4444-555555555555';
const REPO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const mocks = vi.hoisted(() => ({
  epoch: null as string | null,
  add: vi.fn(),
  probe: vi.fn(),
  reject: vi.fn(),
  upgrade: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => ({ id: TASK, repositoryId: REPO }) },
      repositories: { findFirst: async () => ({ status: 'ready' }) },
    },
  }),
}));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ get: async () => mocks.epoch }) }));
vi.mock('../src/queues.js', () => ({
  getRuntimeEnsureQueue: () => ({ add: mocks.add }),
  getRuntimeEnsureQueueEvents: () => ({}),
}));
vi.mock('../src/lib/upgrade-auth.js', () => ({
  authenticateUpgrade: async () => ({ userId: 'owner', session: { revoked: false } }),
  rejectUpgrade: (...args: unknown[]) => mocks.reject(...args),
}));
vi.mock('ws', () => ({
  WebSocketServer: class {
    handleUpgrade = mocks.upgrade;
  },
}));
vi.mock('node:net', () => ({ default: { connect: (...args: unknown[]) => mocks.probe(...args) } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue({ waitUntilFinished: async () => ({ ok: true }) });
  mocks.probe.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    queueMicrotask(() => socket.emit('error', new Error('desktop offline')));
    return socket;
  });
});

// Drive the installed production listener with transport seams only. Checkout admission,
// URL parsing and runtime-ensure dispatch remain real; no server or container is started.
async function upgrade(query: string) {
  const server = new EventEmitter();
  installBrowserVncWebSocket(server as Server);
  const socket = Object.assign(new EventEmitter(), { destroy() {} });
  const result = new Promise<'accepted' | number>((resolve) => {
    mocks.reject.mockImplementation((_socket, status) => resolve(status));
    mocks.upgrade.mockImplementation(() => resolve('accepted'));
  });
  server.emit(
    'upgrade',
    { url: `/browser-vnc/${TASK}${query}`, headers: {} },
    socket,
    Buffer.alloc(0),
  );
  return result;
}

it.each(['', '?checkoutEpoch=stale'])(
  'refuses %s before probing or ensuring a replacement runtime',
  async (query) => {
    mocks.epoch = 'current';
    expect(await upgrade(query)).toBe(409);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.upgrade).not.toHaveBeenCalled();
  },
);

it.each([
  { epoch: 'current epoch/+?', query: `?checkoutEpoch=${encodeURIComponent('current epoch/+?')}` },
  { epoch: null, query: '' },
])('accepts the matching epoch $epoch and cold-boots the runtime', async ({ epoch, query }) => {
  mocks.epoch = epoch;
  expect(await upgrade(query)).toBe('accepted');
  expect(mocks.add).toHaveBeenCalledOnce();
  expect(mocks.add).toHaveBeenCalledWith(
    expect.any(String),
    { taskId: TASK, userId: 'owner' },
    expect.objectContaining({ jobId: `ensure-${TASK}` }),
  );
  expect(mocks.reject).not.toHaveBeenCalled();
  expect(mocks.upgrade).toHaveBeenCalledOnce();
});
