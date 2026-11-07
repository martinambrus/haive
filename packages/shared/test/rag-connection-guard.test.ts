import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, configService } from '../src/config/config.service.js';
import { resolveRagConnection, type RagToolingPrefs } from '../src/rag/connection.js';

const existingDatabase = { execute: async () => [{ '?column?': 1 }] } as unknown as Database;

let server: Server;
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
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const prefs = (ragMode: 'external' | 'ddev'): RagToolingPrefs => ({
  ragMode,
  ragConnectionString: `postgres://u:p@127.0.0.1:${port}/db`,
  ollamaUrl: null,
  embeddingModel: null,
  embeddingDimensions: 8,
});

/** Run one `select 1` through the real resolver; the listener drops whatever it accepts. */
async function dial(ragMode: 'external' | 'ddev', trustedTarget?: boolean): Promise<number> {
  const conn = await resolveRagConnection(prefs(ragMode), existingDatabase, 'project', {
    connectTimeoutSeconds: 2,
    fetchTypes: false,
    ...(trustedTarget === undefined ? {} : { trustedTarget }),
  });
  const started = Date.now();
  try {
    await conn!.pg.unsafe('select 1').catch(() => {});
  } finally {
    await conn!.close();
  }
  return Date.now() - started;
}

describe.each(['external', 'ddev'] as const)(
  'a stored %s RAG store is dialled through the guard',
  (mode) => {
    it('refuses a loopback store when the allowlist is empty', async () => {
      const ms = await dial(mode);
      expect(ms).toBeLessThan(2000);
      expect(accepted).toBe(0);
    });

    it('dials a loopback store the allowlist covers', async () => {
      allowlist = '127.0.0.1';
      await dial(mode);
      expect(accepted).toBeGreaterThanOrEqual(1);
    });

    it('dials a trusted operator target with an empty allowlist', async () => {
      await dial(mode, true);
      expect(accepted).toBeGreaterThanOrEqual(1);
    });
  },
);
