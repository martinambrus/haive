import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIMS = 8;
const LOCAL_OLLAMA = 'http://local-ollama.test';
const GLOBAL_OLLAMA = 'http://global-ollama.test';
const SECRET = 'rag-search-route-test-secret';

type Embed = { vector?: number[]; fail?: boolean; delayMs?: number };
type Hit = { sourcePath: string; rrf: number; sourceType: string };

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  localEmbed: {} as Embed,
  globalEmbed: {} as Embed,
  localHits: [] as Hit[],
  globalHits: [] as Hit[],
  search: vi.fn(),
  events: [] as string[],
  openOptions: [] as unknown[],
  statements: [] as string[],
  tx: {} as { unsafe: (statement: string) => Promise<unknown[]> },
  pg: {} as unknown,
  realStore: false,
  connectionString: '',
  localOpenOptions: [] as unknown[],
  localStatements: [] as string[],
  localTx: {} as { unsafe: (statement: string) => Promise<unknown[]> },
  localPg: {} as unknown,
  localEnds: [] as unknown[],
  realLocalStore: false,
  localConnectionString: '',
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveTaskStackContext: async () => ({
      repositoryId: 'repo-1',
      tooling: {
        ragMode: h.realLocalStore ? 'external' : 'internal',
        ragConnectionString: h.localConnectionString,
        ollamaUrl: LOCAL_OLLAMA,
        embeddingModel: 'local-model',
        embeddingDimensions: DIMS,
      },
      envDetectData: null,
      confirmed: null,
    }),
    withGlobalKb: async (...args: Parameters<typeof actual.withGlobalKb>) => {
      const [, fn, options] = args;
      h.events.push('open');
      h.openOptions.push(options);
      if (h.realStore) return actual.withGlobalKb(...args);
      return fn({
        conn: { embeddingDimensions: DIMS, pg: h.pg },
        db: {},
        settings: await actual.resolveGlobalKbSettings(),
      } as unknown as GlobalKbContext);
    },
  };
});
vi.mock('@haive/shared/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/rag')>();
  return {
    ...actual,
    resolveRagConnection: async (...args: Parameters<typeof actual.resolveRagConnection>) => {
      h.localOpenOptions.push(args[3]);
      if (h.realLocalStore) return actual.resolveRagConnection(...args);
      return { embeddingDimensions: DIMS, pg: h.localPg, close: async () => {} };
    },
    ragHybridSearch: (...args: unknown[]) => h.search(...args),
  };
});

import net from 'node:net';
import { Hono } from 'hono';
import { CONFIG_KEYS, configService, secretsService } from '@haive/shared';
import type { GlobalKbContext } from '@haive/shared/global-kb';
import { signRagToken } from '@haive/shared/rag';
import { ragRoutes } from '../src/routes/rag.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/rag', ragRoutes);
app.onError(errorHandler);

const hit = (sourcePath: string, sourceType: string, rrf: number): Hit => ({
  sourcePath,
  sourceType,
  rrf,
});

type SearchConfig = { lexicalOnly?: boolean };
type SearchCall = { pg: unknown; vec: number[]; config: SearchConfig; filter: unknown };

/** The calls ragHybridSearch got, split by store: only the global KB search passes a facet filter. */
function searches(): { local: SearchCall[]; global: SearchCall[] } {
  const calls = h.search.mock.calls.map(([conn, vec, , config, filter]): SearchCall => ({
    pg: conn.pg,
    vec,
    config,
    filter,
  }));
  return {
    local: calls.filter((c) => c.filter === undefined),
    global: calls.filter((c) => c.filter !== undefined),
  };
}

async function search(): Promise<{ status: number; paths: string[] }> {
  const res = await app.request('/rag/search', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${signRagToken('task-1', SECRET)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query: 'where is the session cookie set' }),
  });
  const body = (await res.json().catch(() => ({}))) as { hits?: Hit[] };
  return { status: res.status, paths: (body.hits ?? []).map((x) => x.sourcePath) };
}

beforeEach(() => {
  vi.stubEnv('CONFIG_ENCRYPTION_KEY', SECRET);
  h.db = {
    query: {
      tasks: {
        findFirst: async () => ({ title: 'Add a feature', description: null, metadata: {} }),
      },
      repositories: {
        findFirst: async () => ({ ragEmbedLexicalOnly: false, ragEmbedDegradedAt: null }),
      },
    },
    insert: () => ({ values: async () => {} }),
  };
  h.localEmbed = { vector: Array(DIMS).fill(0.1) };
  h.globalEmbed = { vector: Array(DIMS).fill(0.2) };
  h.localHits = [hit('src/session.ts', 'code', 0.05)];
  h.globalHits = [hit('global_kb/cookies-11111111.md', 'kb', 0.04)];
  h.events = [];
  h.openOptions = [];
  h.statements = [];
  h.tx = {
    unsafe: async (statement) => {
      h.statements.push(statement);
      return [];
    },
  };
  h.pg = {
    unsafe: async (statement: string) => {
      h.statements.push(`outside a transaction: ${statement}`);
      return [];
    },
    begin: async (run: (tx: unknown) => Promise<unknown>) => {
      h.statements.push('begin');
      return run(h.tx);
    },
  };
  h.realStore = false;
  h.connectionString = 'postgres://kb:kb@127.0.0.1:1/kb';
  h.localOpenOptions = [];
  h.localEnds = [];
  h.localStatements = [];
  h.localTx = {
    unsafe: async (statement) => {
      h.localStatements.push(statement);
      return [];
    },
  };
  h.localPg = {
    unsafe: async (statement: string) => {
      h.localStatements.push(`outside a transaction: ${statement}`);
      return [];
    },
    begin: async (run: (tx: unknown) => Promise<unknown>) => {
      h.localStatements.push('begin');
      return run(h.localTx);
    },
    end: async (options: unknown) => {
      h.localEnds.push(options);
    },
  };
  h.realLocalStore = false;
  h.localConnectionString = 'postgres://rag:rag@127.0.0.1:1/rag';
  h.search.mockReset();
  h.search.mockImplementation(
    async (
      conn: { embeddingDimensions: number },
      vec: number[],
      _text: string,
      config: SearchConfig,
      filter: unknown,
    ) => {
      // pgvector refuses a query vector of another width (SQLSTATE 22000, measured on pgvector/pgvector:pg18).
      if (!config.lexicalOnly && vec.length !== conn.embeddingDimensions) {
        throw Object.assign(
          new Error(`expected ${conn.embeddingDimensions} dimensions, not ${vec.length}`),
          { code: '22000' },
        );
      }
      return filter === undefined ? h.localHits : h.globalHits;
    },
  );

  const config = new Map<string, string>([
    [CONFIG_KEYS.GLOBAL_KB_MODE, 'external'],
    [CONFIG_KEYS.GLOBAL_KB_OLLAMA_URL, GLOBAL_OLLAMA],
    [CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL, 'global-model'],
  ]);
  vi.spyOn(configService, 'get').mockImplementation(async (key) => config.get(key) ?? null);
  vi.spyOn(configService, 'getBoolean').mockImplementation(
    async (_key, fallback = false) => fallback,
  );
  vi.spyOn(configService, 'getNumber').mockImplementation(async (key, fallback = 0) =>
    key === CONFIG_KEYS.GLOBAL_KB_EMBED_DIMS ? DIMS : fallback,
  );
  vi.spyOn(secretsService, 'get').mockImplementation(async () => h.connectionString);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const isGlobal = String(url).startsWith(GLOBAL_OLLAMA);
      const embed = isGlobal ? h.globalEmbed : h.localEmbed;
      h.events.push(isGlobal ? 'embed:global' : 'embed:local');
      if (embed.delayMs) await new Promise((resolve) => setTimeout(resolve, embed.delayMs));
      if (embed.fail) throw new Error('connection refused');
      return { ok: true, json: async () => ({ embeddings: [embed.vector] }) };
    }),
  );
});

const stores: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((close) => close()));
});

describe('rag_search, the global half', () => {
  it('searches lexical-only, with no vector, when its query embed fails', async () => {
    h.globalEmbed = { fail: true };

    const { status, paths } = await search();

    expect(status).toBe(200);
    const { global } = searches();
    expect(global).toHaveLength(1);
    expect.soft(global[0]!.vec).toEqual([]);
    expect.soft(global[0]!.config.lexicalOnly).toBe(true);
    expect(paths).toContain('global_kb/cookies-11111111.md');
  });

  it('gives the global search its dense vector when the query embeds', async () => {
    const { status } = await search();

    expect(status).toBe(200);
    const { global, local } = searches();
    expect(global[0]!.config.lexicalOnly).toBeFalsy();
    expect(global[0]!.vec).toEqual(h.globalEmbed.vector);
    expect(local[0]!.config.lexicalOnly).toBe(false);
  });
});

describe('rag_search, a query vector of the wrong width', () => {
  const WRONG = Array(DIMS - 5).fill(0.3);

  it('searches the local half lexical-only and does not answer 500', async () => {
    h.localEmbed = { vector: WRONG };

    const { status, paths } = await search();

    expect(status).toBe(200);
    const { local } = searches();
    expect.soft(local[0]!.vec).toEqual([]);
    expect.soft(local[0]!.config.lexicalOnly).toBe(true);
    expect(paths).toContain('src/session.ts');
  });

  it('searches the global half lexical-only and still serves its hits', async () => {
    h.globalEmbed = { vector: WRONG };

    const { status, paths } = await search();

    expect(status).toBe(200);
    const { global } = searches();
    expect.soft(global[0]!.vec).toEqual([]);
    expect.soft(global[0]!.config.lexicalOnly).toBe(true);
    expect(paths).toContain('global_kb/cookies-11111111.md');
  });
});

const AUTH_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
const READY_FOR_QUERY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);

/** A Postgres that never speaks, or completes the startup handshake and then says nothing or hangs up on the first query. */
async function fakePostgres(behaviour: 'mute' | 'silent' | 'hang-up') {
  const sockets = new Set<net.Socket>();
  const seen = { connections: 0, queries: 0 };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let started = false;
    socket.on('data', () => {
      if (behaviour === 'mute') return;
      if (!started) {
        started = true;
        socket.write(Buffer.concat([AUTH_OK, READY_FOR_QUERY]));
        return;
      }
      seen.queries += 1;
      if (behaviour === 'hang-up') socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stores.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as net.AddressInfo;
  return { url: `postgres://kb:kb@127.0.0.1:${port}/kb`, seen };
}

describe('rag_search, the global store', () => {
  const EMBED_MS = 1_500;
  const DEADLINE_MS = 6_000;

  it('embeds the query before it opens the store, and opens it with the dispatch bounds', async () => {
    await search();

    expect(h.events.filter((event) => event !== 'embed:local')).toEqual(['embed:global', 'open']);
    expect(h.openOptions).toEqual([{ connectTimeoutSeconds: 3, deadlineMs: DEADLINE_MS }]);
  });

  it('reads the store in one transaction, under a server-side statement timeout', async () => {
    await search();

    expect(h.statements.slice(0, 2)).toEqual(['begin', "SET LOCAL statement_timeout = '3000ms'"]);
    expect(h.statements.filter((statement) => statement.startsWith('outside'))).toEqual([]);
    expect(searches().global[0]!.pg).toBe(h.tx);
  });

  it('answers with the local hits when the server cancels a statement', async () => {
    h.tx.unsafe = async (statement) => {
      if (statement.startsWith('SET LOCAL')) return [];
      throw Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
    };

    const { status, paths } = await search();

    expect(status).toBe(200);
    expect(paths).toEqual(['src/session.ts']);
  });

  it('answers with the local hits when the store never answers, a deadline after the embed', async () => {
    const store = await fakePostgres('silent');
    h.realStore = true;
    h.connectionString = store.url;
    h.globalEmbed = { vector: Array(DIMS).fill(0.2), delayMs: EMBED_MS };

    const started = Date.now();
    const { status, paths } = await search();
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(paths).toEqual(['src/session.ts']);
    expect(store.seen.queries).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(EMBED_MS + DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(EMBED_MS + DEADLINE_MS + 2_000);
  }, 20_000);

  it('answers with the local hits when the store accepts the connection and never speaks', async () => {
    const store = await fakePostgres('mute');
    h.realStore = true;
    h.connectionString = store.url;

    const started = Date.now();
    const { status, paths } = await search();
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(paths).toEqual(['src/session.ts']);
    expect(store.seen.connections).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
  }, 20_000);

  it('answers with the local hits when the store hangs up on its first query', async () => {
    const store = await fakePostgres('hang-up');
    h.realStore = true;
    h.connectionString = store.url;

    const started = Date.now();
    const { status, paths } = await search();
    const elapsed = Date.now() - started;

    expect(status).toBe(200);
    expect(paths).toEqual(['src/session.ts']);
    expect(store.seen.queries).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000);
  }, 20_000);
});

describe('rag_search, the local store', () => {
  const EMBED_MS = 1_500;
  const DEADLINE_MS = 6_000;

  const failLocal = (error: Error): void => {
    h.search.mockImplementation(async (_conn, _vec, _text, _config, filter) => {
      if (filter === undefined) throw error;
      return h.globalHits;
    });
  };

  // The stubbed search never touches its store, so make it ask the way the real one's first statement does.
  const searchAsksStore = (): void => {
    h.search.mockImplementation(
      async (conn: { pg: { unsafe: (statement: string) => Promise<unknown> } }) => {
        await conn.pg.unsafe('SELECT 1');
        return h.localHits;
      },
    );
  };

  it('opens the store with a connect timeout and without the driver type fetch', async () => {
    await search();

    expect(h.localOpenOptions).toEqual([{ connectTimeoutSeconds: 3, fetchTypes: false }]);
  });

  it('reads the store in one transaction, under a server-side statement timeout', async () => {
    await search();

    expect(h.localStatements).toEqual(['begin', "SET LOCAL statement_timeout = '3000ms'"]);
    const { local } = searches();
    expect(local).toHaveLength(1);
    expect(local[0]!.pg).toBe(h.localTx);
    const call = h.search.mock.calls.find(([, , , , filter]) => filter === undefined)!;
    expect(call[5]).toBe('repo-1');
    expect(h.localEnds).toEqual([]);
  });

  it('answers 500, and destroys the pool at once, when the server cancels a statement', async () => {
    failLocal(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );

    const { status } = await search();

    expect(status).toBe(500);
    expect(h.localEnds).toEqual([{ timeout: 0 }]);
  });

  it('answers with the global hits when the index is not built yet', async () => {
    failLocal(
      Object.assign(new Error('relation "ai_rag_embeddings" does not exist'), { code: '42P01' }),
    );

    const { status, paths } = await search();

    expect(status).toBe(200);
    expect(paths).toEqual(['global_kb/cookies-11111111.md']);
  });

  it('answers 500 when the store goes silent, a deadline after the embed', async () => {
    const store = await fakePostgres('silent');
    h.realLocalStore = true;
    h.localConnectionString = store.url;
    searchAsksStore();
    h.localEmbed = { vector: Array(DIMS).fill(0.1), delayMs: EMBED_MS };

    const started = Date.now();
    const { status } = await search();
    const elapsed = Date.now() - started;

    expect(status).toBe(500);
    expect(store.seen.queries).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(EMBED_MS + DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(EMBED_MS + DEADLINE_MS + 2_000);
  }, 20_000);

  it('answers 500 when the store accepts the connection and never speaks', async () => {
    const store = await fakePostgres('mute');
    h.realLocalStore = true;
    h.localConnectionString = store.url;
    searchAsksStore();

    const started = Date.now();
    const { status } = await search();
    const elapsed = Date.now() - started;

    expect(status).toBe(500);
    expect(store.seen.connections).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(DEADLINE_MS);
  }, 20_000);

  it('answers 500 when the store hangs up on its first query', async () => {
    const store = await fakePostgres('hang-up');
    h.realLocalStore = true;
    h.localConnectionString = store.url;
    searchAsksStore();

    const started = Date.now();
    const { status } = await search();
    const elapsed = Date.now() - started;

    expect(status).toBe(500);
    expect(store.seen.queries).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(DEADLINE_MS);
  }, 20_000);
});
