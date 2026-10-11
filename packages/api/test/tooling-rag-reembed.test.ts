import { afterEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  realStore: false,
  openOptions: [] as unknown[],
  statements: [] as Array<{ statement: string; params: unknown[] | undefined }>,
  batches: [0] as Array<number | { code: string }>,
  hang: false,
  ended: 0,
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
        pg: (() => {
          const unsafe = async (statement: string, params?: unknown[]) => {
            h.statements.push({ statement, params });
            if (!statement.startsWith('UPDATE')) return [];
            if (h.hang) return new Promise(() => {});
            const next = h.batches.shift() ?? 0;
            if (typeof next !== 'number') throw Object.assign(new Error('canceled'), next);
            return Object.assign([], { count: next });
          };
          return {
            unsafe,
            begin: async (run: (tx: { unsafe: typeof unsafe }) => unknown) => run({ unsafe }),
            end: async () => {
              h.ended += 1;
            },
          };
        })(),
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
  h.batches = [0];
  h.hang = false;
  h.ended = 0;
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
  it('resets the chunk hashes of that repository in batches, on a store opened with a connect timeout', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 500, 120, 0];

    const res = await rebuild();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reembedQueued: true });
    const updates = h.statements.filter((s) => s.statement.startsWith('UPDATE'));
    expect(updates).toHaveLength(4);
    for (const update of updates) {
      expect(update.statement).toContain('chunk_hash = NULL');
      expect(update.statement).toContain('chunk_hash IS NOT NULL');
      expect(update.statement).toContain('LIMIT 500');
      expect(update.params).toEqual([REPO]);
    }
    expect(h.openOptions).toEqual([{ connectTimeoutSeconds: 3, fetchTypes: false }]);
  });

  it('sets a statement timeout inside every batch transaction, before its UPDATE', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, 500, 0];

    await rebuild();

    expect(h.statements.map((s) => s.statement.split(/\s+/).slice(0, 2).join(' '))).toEqual([
      'SET LOCAL',
      'UPDATE ai_rag_embeddings',
      'SET LOCAL',
      'UPDATE ai_rag_embeddings',
      'SET LOCAL',
      'UPDATE ai_rag_embeddings',
    ]);
    expect(h.statements[0]!.statement).toBe("SET LOCAL statement_timeout = '3000ms'");
  });

  it('answers 503 with the number of chunks already marked when a batch hits the statement timeout', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [500, { code: '57014' }];

    const res = await rebuild();

    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('after 500 chunks were marked'),
    });
  });

  it('answers 503 at the deadline when the store accepts a statement and never answers', async () => {
    vi.useFakeTimers();
    try {
      setup('postgres://rag:rag@127.0.0.1:1/rag');
      h.hang = true;

      const pending = rebuild();
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('not finished'),
      });
      expect(h.ended).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failure that is not a timeout a 500', async () => {
    setup('postgres://rag:rag@127.0.0.1:1/rag');
    h.batches = [{ code: '42P01' }];

    expect((await rebuild()).status).toBe(500);
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
