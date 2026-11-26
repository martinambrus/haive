import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, configService } from '../src/config/config.service.js';
import { resolveRagConnection, type RagToolingPrefs } from '../src/rag/connection.js';

const existingDatabase = { execute: async () => [{ '?column?': 1 }] } as unknown as Database;

// A PostgreSQL ErrorResponse ends startup without a retryable CONNECTION_CLOSED.
// An accept-and-destroy listener can surface either ECONNRESET or CONNECTION_CLOSED;
// the latter enters postgres.js's randomized backoff until connect_timeout.
const startupFields = Buffer.from('SFATAL\0C28P01\0MFixture rejects authentication\0\0');
const startupError = Buffer.alloc(5 + startupFields.length);
startupError.write('E');
startupError.writeInt32BE(4 + startupFields.length, 1);
startupFields.copy(startupError, 5);

let server: Server;
const sockets = new Set<Socket>();
let accepted = 0;
let port = 0;
let allowlist = '';

beforeEach(async () => {
  accepted = 0;
  allowlist = '';
  vi.spyOn(configService, 'get').mockImplementation(async (key: string) =>
    key === CONFIG_KEYS.PRIVATE_ENDPOINT_ALLOWLIST ? allowlist : '',
  );
  server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => socket.end(startupError));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const prefs = (ragMode: 'external' | 'ddev'): RagToolingPrefs => ({
  ragMode,
  ragConnectionString: `postgres://u:p@127.0.0.1:${port}/db`,
  ollamaUrl: null,
  embeddingModel: null,
  embeddingDimensions: 8,
});

/** The real resolver and guard must reach the listener's terminal startup refusal. */
async function dial(ragMode: 'external' | 'ddev', trustedTarget?: boolean): Promise<void> {
  const conn = await resolveRagConnection(prefs(ragMode), existingDatabase, 'project', {
    connectTimeoutSeconds: 2,
    fetchTypes: false,
    ...(trustedTarget === undefined ? {} : { trustedTarget }),
  });
  try {
    await conn!.pg.unsafe('select 1');
  } finally {
    await conn!.close();
  }
}

describe.each(['external', 'ddev'] as const)(
  'a stored %s RAG store is dialled through the guard',
  (mode) => {
    it('refuses a loopback store when the allowlist is empty', async () => {
      await expect(dial(mode)).rejects.toThrow();
      expect(accepted).toBe(0);
    });

    it('dials a loopback store the allowlist covers', async () => {
      allowlist = '127.0.0.1';
      await expect(dial(mode)).rejects.toMatchObject({ code: '28P01' });
      expect(accepted).toBe(1);
    });

    it('dials a trusted operator target with an empty allowlist', async () => {
      await expect(dial(mode, true)).rejects.toMatchObject({ code: '28P01' });
      expect(accepted).toBe(1);
    });
  },
);
