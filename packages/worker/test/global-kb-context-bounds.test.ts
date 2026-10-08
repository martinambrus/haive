import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, SECRET_KEYS, configService, secretsService } from '@haive/shared';

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return { ...actual, resolveTaskFacets: async () => actual.emptyProjectFacetSet() };
});

import { resolveGlobalKbContext } from '../src/orchestrator/global-kb-context.js';

const USER = 'kbuser';
const PASSWORD = 'kb-secret-password';

interface FakeServer {
  port: number;
  connections: () => { total: number; open: number };
  stop: () => Promise<void>;
}

/** A TCP server standing in for a global KB store. `greet` decides how far a connection gets. */
async function listen(greet: (socket: net.Socket) => void): Promise<FakeServer> {
  const sockets = new Set<net.Socket>();
  let total = 0;
  const server = net.createServer((socket) => {
    total += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
    greet(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => ({ total, open: sockets.size }),
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Int32 length, a tag byte and a body: the only postgres messages a handshake needs. */
function message(tag: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(tag, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

/** Authenticates anyone, says ready for query, and never answers another word. */
const goesSilentAfterReady = (socket: net.Socket): void => {
  socket.once('data', () => {
    const ok = Buffer.alloc(4);
    socket.write(Buffer.concat([message('R', ok), message('Z', Buffer.from('I'))]));
  });
};

const neverSpeaks = (): void => {};

const settle = (condition: () => boolean, ms: number) =>
  vi.waitFor(() => expect(condition()).toBe(true), { timeout: ms, interval: 25 });

describe('resolveGlobalKbContext against a store that does not answer', () => {
  let server: FakeServer | null = null;

  const pointAt = (port: number) => {
    const values: Record<string, string> = {
      [CONFIG_KEYS.GLOBAL_KB_MODE]: 'external',
      [CONFIG_KEYS.GLOBAL_KB_NAMESPACE]: 'default',
    };
    vi.spyOn(configService, 'get').mockImplementation(async (key: string) => values[key] ?? null);
    vi.spyOn(secretsService, 'get').mockImplementation(async (key: string) =>
      key === SECRET_KEYS.GLOBAL_KB_CONNECTION_STRING
        ? `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/kb`
        : null,
    );
  };

  beforeEach(() => {
    server = null;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.stop();
  });

  const read = async (bounds: Parameters<typeof resolveGlobalKbContext>[3]) => {
    const started = performance.now();
    const out = await resolveGlobalKbContext(
      {} as Database,
      'task-1',
      { houseRules: true },
      bounds,
    );
    return { out, ms: performance.now() - started };
  };

  it('stops waiting for a socket that accepts and never answers, after the connect timeout', async () => {
    server = await listen(neverSpeaks);
    pointAt(server.port);
    const { out, ms } = await read({
      connectTimeoutSeconds: 1,
      statementTimeoutMs: 1000,
      deadlineMs: 5000,
    });

    expect(out).toMatchObject({
      status: 'unavailable',
      errorClass: 'timeout',
      rules: [],
      refused: [],
    });
    expect(out.digest.entries).toEqual([]);
    expect(ms).toBeGreaterThan(800);
    expect(ms).toBeLessThan(3000);
    expect(server.connections().total).toBeGreaterThanOrEqual(1);
    await settle(() => server!.connections().open === 0, 2000);
  });

  it('stops waiting for a socket that goes silent after the connection was made, at the deadline', async () => {
    server = await listen(goesSilentAfterReady);
    pointAt(server.port);
    const { out, ms } = await read({
      connectTimeoutSeconds: 30,
      statementTimeoutMs: 30_000,
      deadlineMs: 1200,
    });

    expect(out).toMatchObject({ status: 'unavailable', errorClass: 'timeout' });
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(3000);
    await settle(() => server!.connections().open === 0, 2000);
  });

  it('says a store nothing listens on refused the connection', async () => {
    server = await listen(neverSpeaks);
    const port = server.port;
    await server.stop();
    server = null;
    pointAt(port);
    const { out, ms } = await read({
      connectTimeoutSeconds: 5,
      statementTimeoutMs: 1000,
      deadlineMs: 5000,
    });

    expect(out).toMatchObject({ status: 'unavailable', errorClass: 'refused' });
    expect(ms).toBeLessThan(3000);
  });

  it('names neither the host nor the credentials of the store in what it returns', async () => {
    server = await listen(neverSpeaks);
    pointAt(server.port);
    const { out } = await read({
      connectTimeoutSeconds: 1,
      statementTimeoutMs: 1000,
      deadlineMs: 3000,
    });

    const everything = JSON.stringify(out);
    for (const secret of ['127.0.0.1', String(server.port), USER, PASSWORD]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('leaves no rejection nobody awaits when the deadline destroys a pool mid-handshake', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      server = await listen(goesSilentAfterReady);
      pointAt(server.port);
      await read({ connectTimeoutSeconds: 30, statementTimeoutMs: 30_000, deadlineMs: 600 });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });
});
