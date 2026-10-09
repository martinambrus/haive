import { afterEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  realStore: false,
  openOptions: [] as unknown[],
  statements: [] as Array<{ statement: string; params: unknown[] | undefined }>,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/rag')>();
  return {
    ...actual,
    resolveRagConnection: async (...args: Parameters<typeof actual.resolveRagConnection>) => {
      h.openOptions.push(args[3]);
      if (h.realStore) return actual.resolveRagConnection(...args);
      return {
        mode: 'external',
        embeddingDimensions: 8,
        pg: {
          unsafe: async (statement: string, params?: unknown[]) => {
            h.statements.push({ statement, params });
            return [];
          },
        },
        close: async () => {},
      };
    },
  };
});

import net from 'node:net';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ONBOARDING_TOOLING_SCHEMA_VERSION } from '@haive/shared';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

function setup(ragConnectionString: string): void {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'r',
    source: 'local_path',
    onboardingTooling: {
      schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION,
      tooling: { ragMode: 'external', ragConnectionString, embeddingDimensions: 8 },
    },
  });
  h.db = fake.db;
  h.realStore = false;
  h.openOptions = [];
  h.statements = [];
}

const rebuild = () =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ragEmbedAction: 'rebuild_index' }),
  });

const stores: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((close) => close()));
});

/** A Postgres that accepts the connection and never speaks. */
async function mutePostgres() {
  const sockets = new Set<net.Socket>();
  const seen = { connections: 0 };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stores.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as net.AddressInfo;
  return { url: `postgres://rag:rag@127.0.0.1:${port}/rag`, seen };
}

describe('forcing a re-embed of a repository', () => {
  it('nulls the chunk hashes of that repository, on a store opened with a connect timeout', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');

    const res = await rebuild();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reembedQueued: true });
    expect(h.statements).toEqual([
      {
        statement: 'UPDATE ai_rag_embeddings SET chunk_hash = NULL WHERE repository_id = $1',
        params: [REPO],
      },
    ]);
    expect(h.openOptions).toEqual([{ connectTimeoutSeconds: 3 }]);
  });

  it('answers its error within the connect timeout when the store accepts the connection and never speaks', async () => {
    const store = await mutePostgres();
    setup(store.url);
    h.realStore = true;

    const started = Date.now();
    const res = await rebuild();
    const elapsed = Date.now() - started;

    expect(res.status).toBe(500);
    expect(store.seen.connections).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);
  }, 40_000);
});
