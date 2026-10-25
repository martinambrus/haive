import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http, { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TERMINAL_ATTACH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/terminal_attach_test'))
  throw new Error('Use a dedicated terminal_attach_test database for terminal attach tests');

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
  return { db: undefined as unknown, userId: '' };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/auth/jwt.js', () => ({
  verifyAccessToken: async () => ({ sub: h.userId, role: 'user', tv: 0 }),
}));

import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { closeUserSockets } from '../src/lib/user-sockets.js';

const N = 8; // Leaves two of the ten pool connections for the held row lock and observer.
const WAIT = { timeout: 5_000, interval: 10 };

describe.skipIf(!url)('terminal attach counts on Postgres', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let containerId: string;
  const clients: WebSocket[] = [];
  const peers = new Set<Socket>();
  const streams: PassThrough[] = [];

  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.userId = randomUUID();
    await db.insert(schema.users).values({
      id: h.userId,
      emailEncrypted: 'terminal-attach@test.local',
      emailBlindIndex: randomUUID(),
      passwordHash: 'unused',
    });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId: h.userId,
        type: 'workflow',
        title: 'terminal attach concurrency',
      })
      .returning({ id: schema.tasks.id });
    const [container] = await db
      .insert(schema.containers)
      .values({
        taskId: task!.id,
        status: 'running',
        dockerContainerId: 'test-container',
      })
      .returning({ id: schema.containers.id });
    containerId = container!.id;
    const realRequest = http.request.bind(http);
    vi.spyOn(http, 'request').mockImplementation(((
      opts: http.RequestOptions,
      ...args: unknown[]
    ) => {
      if (!opts.path?.startsWith('/containers/test-container/attach'))
        return Reflect.apply(realRequest, http, [opts, ...args]);
      const stream = new PassThrough();
      streams.push(stream);
      const req = new EventEmitter();
      Object.assign(req, {
        end: () => queueMicrotask(() => req.emit('upgrade', {}, stream, Buffer.alloc(0))),
      });
      return req;
    }) as typeof http.request);
    server = createServer();
    server.on('connection', (peer) => {
      peers.add(peer);
      peer.once('close', () => peers.delete(peer));
    });
    installTerminalWebSocket(server, {
      docker: { modem: { getSocketPath: () => undefined }, getContainer: () => ({}) } as never,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.terminalSessions)
        .where(eq(schema.terminalSessions.containerId, containerId));
      expect(rows.every((row) => row.endedAt !== null)).toBe(true);
    }, WAIT);
    for (const stream of streams.splice(0)) stream.destroy();
    vi.restoreAllMocks();
    await db.delete(schema.users).where(eq(schema.users.id, h.userId));
  });

  const count = async () => {
    const [row] = await db
      .select({ count: schema.containers.attachedWsCount })
      .from(schema.containers)
      .where(eq(schema.containers.id, containerId));
    return row!.count;
  };
  const open = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/terminal/${containerId}`, {
        headers: { cookie: 'haive_access=test-session' },
      });
      clients.push(client);
      client.on('error', reject);
      client.on('message', (raw) => {
        if (JSON.parse(raw.toString()).type === 'connected') resolve(client);
      });
    });

  // All count writes wait on the SAME real row lock. On the old code each SELECT sees the
  // same starting value, then its UPDATE queues here. Atomic UPDATEs re-read the locked row.
  async function whileCountLocked(action: () => Promise<void>) {
    const connection = await db.$client.reserve();
    try {
      const [holder] = await connection`SELECT pg_backend_pid() AS pid`;
      await connection`BEGIN`;
      await connection`SELECT id FROM containers WHERE id = ${containerId} FOR UPDATE`;
      await action();
      // Writers can wait behind another writer instead of directly on the holder.
      // Follow the lock chain so all N count writes must be parked before release.
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ waiting: number }>(sql`
          WITH RECURSIVE waiters(pid) AS (
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND ${holder!.pid}::int = ANY(pg_blocking_pids(pid))
            UNION
            SELECT activity.pid FROM pg_stat_activity AS activity
            JOIN waiters ON waiters.pid = ANY(pg_blocking_pids(activity.pid))
            WHERE activity.datname = current_database()
          )
          SELECT count(*)::int AS waiting FROM waiters
        `);
        expect(row!.waiting).toBe(N);
      }, WAIT);
    } finally {
      await connection`ROLLBACK`;
      connection.release();
    }
  }

  it('releases all N attachments when revocation closes N sockets concurrently', async () => {
    for (let i = 0; i < N; i++) await open();
    expect(await count()).toBe(N);
    await whileCountLocked(async () => {
      expect(closeUserSockets(h.userId)).toBe(N);
    });
    await vi.waitFor(async () => expect(await count()).toBe(0), WAIT);
    expect(streams.every((stream) => stream.writableEnded)).toBe(true);
  }, 15_000);

  it('counts N concurrent attachments, then clamps concurrent decrements at zero', async () => {
    const opened: Promise<WebSocket>[] = [];
    await whileCountLocked(async () => {
      for (let i = 0; i < N; i++) opened.push(open());
    });
    await Promise.all(opened);
    expect(await count()).toBe(N);
    await db
      .update(schema.containers)
      .set({ attachedWsCount: 1 })
      .where(eq(schema.containers.id, containerId));
    await whileCountLocked(async () => {
      expect(closeUserSockets(h.userId)).toBe(N);
    });
    await vi.waitFor(async () => expect(await count()).toBe(0), WAIT);
  }, 15_000);
});
