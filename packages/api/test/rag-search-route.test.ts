import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIMS = 8;
const LOCAL_OLLAMA = 'http://local-ollama.test';
const GLOBAL_OLLAMA = 'http://global-ollama.test';
const SECRET = 'rag-search-route-test-secret';

type Embed = { vector?: number[]; fail?: boolean };
type Hit = { sourcePath: string; rrf: number; sourceType: string };

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  localEmbed: {} as Embed,
  globalEmbed: {} as Embed,
  localHits: [] as Hit[],
  globalHits: [] as Hit[],
  search: vi.fn(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveTaskStackContext: async () => ({
      repositoryId: 'repo-1',
      tooling: {
        ragMode: 'internal',
        ollamaUrl: LOCAL_OLLAMA,
        embeddingModel: 'local-model',
        embeddingDimensions: DIMS,
      },
      envDetectData: null,
      confirmed: null,
    }),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({
        conn: { embeddingDimensions: DIMS, pg: { unsafe: async () => [] } },
        db: {},
        settings: await actual.resolveGlobalKbSettings(),
      }),
  };
});
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  resolveRagConnection: async () => ({ embeddingDimensions: DIMS, close: async () => {} }),
  ragHybridSearch: (...args: unknown[]) => h.search(...args),
}));

import { Hono } from 'hono';
import { CONFIG_KEYS, configService, secretsService } from '@haive/shared';
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
type SearchCall = { vec: number[]; config: SearchConfig; filter: unknown };

/** The calls ragHybridSearch got, split by store: only the global KB search passes a facet filter. */
function searches(): { local: SearchCall[]; global: SearchCall[] } {
  const calls = h.search.mock.calls.map(([, vec, , config, filter]): SearchCall => ({
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
  vi.spyOn(secretsService, 'get').mockResolvedValue('postgres://kb:kb@127.0.0.1:1/kb');

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const embed = String(url).startsWith(GLOBAL_OLLAMA) ? h.globalEmbed : h.localEmbed;
      if (embed.fail) throw new Error('connection refused');
      return { ok: true, json: async () => ({ embeddings: [embed.vector] }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
